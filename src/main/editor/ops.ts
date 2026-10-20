import { v4 as uuidv4 } from 'uuid'
import type {
	Clip, EditorDocument, EditorOps, EditorPersona, PromptTurn, TimelineDiff, TimelineItem, Usage
} from '@shared/types'
import {
	applyTimelineDiff, clampSpeed, closeTimelineGaps, computeContentEnd, itemDuration, itemEnd,
	rippleTimeline, TIMELINE_DIFF_SCHEMA_VERSION, type RippleChange
} from '@shared/timeline'
import { DETAIL_MAX_PIECES, EXPAND_MAX_REGIONS } from './context'
import { clampPan } from '@shared/framing'
import { planRangeRemoval } from '@shared/rangeEdit'
import { KEY_DEFAULTS } from '@shared/keying'
import { GENERATOR_DEFAULTS, GENERATORS } from '@shared/generators'
import { hasTransform, OFFSET_RANGE, SCALE_RANGE } from '@shared/transform'
import { defaultParams, effectDef } from '@shared/effects'
import { findTitleTrack, nextTrackOrder, TITLE_TRACK_NAME } from '@shared/tracks'
import {
	freeMotionTrack, lintMotionHtml, motionTemplate, newMotionSpec, nextMotionTrackName, resolveDefinition,
	sanitiseSetting, type MotionSpec
} from '@shared/motion'
import { writtenSpec } from '@shared/motionCode'
import { userMotionTemplate } from '@shared/motionTemplates'
import type { MotionOpSettings } from '@shared/types'
import { isTransitionKind } from '@shared/transitionPresets'
import {
	DEFAULT_TRANSITION_SEC, MAX_TRANSITION_SEC, MIN_TRANSITION_SEC
} from '@shared/transitionPlan'

/**
 * The editor's AI contract: the ops schema the model fills in, the system
 * instruction that explains it, and the pure mapping from ops to a TimelineDiff.
 *
 * Deliberately free of Electron/Node imports so it can be unit-tested — the
 * turn lifecycle that calls it lives in prompt.ts.
 */

// ===== Ops schema (constrained on purpose — see EditorOps in shared/types) =====

/**
 * Emission order for structured output. Prose first, the short scalar second,
 * operations after: left to its own devices the model emitted `targetLength`
 * FIRST and then fused its entire rationale into that string (never closing
 * the quote, running to MAX_TOKENS). Ordering is filtered per call in
 * editorOpsSchema — the API rejects entries that name absent properties.
 */
const PROPERTY_ORDERING = [
	'rationale', 'targetLength', 'answer', 'expandRegions',
	'removeItemIds', 'closeGaps', 'updateItems',
	'addSceneRanges', 'addClips', 'addMarkers'
]

/**
 * Settings travel as key/value PAIRS in the model's schema: constrained
 * decoding cannot express "any key from this template", and a free-form object
 * comes back empty. Values are strings so one type covers text, colours, enum
 * options and numbers alike; `sanitiseSetting` types them on the way in.
 */
const MOTION_SETTINGS_SCHEMA = {
	type: 'array',
	description: 'Template settings to set, by key from AVAILABLE MOTION TEMPLATES. Anything left out keeps its value.',
	items: {
		type: 'object',
		properties: {
			key: { type: 'string' },
			value: { type: 'string', description: 'Text, a #RRGGBB colour, an option, or a number written as text' }
		},
		required: ['key', 'value']
	}
}

const MOTION_HTML_SCHEMA = {
	type: 'string',
	description:
		'A whole self-contained HTML page for a CUSTOM motion layer. It must call ' +
		'frameflow.define({ duration, settings, moments, seek(t, settings) }) and draw only from t and settings. ' +
		'Pages that break the rules (clocks, timers, random, CSS animation, network) are not drawn: the last ' +
		'version that passed stays on screen.'
}

const MOTION_MOMENTS_SCHEMA = {
	type: 'object',
	description: 'Window lengths in seconds. `in` and `out` are the entrance and exit; `hold` is the time fully on screen.',
	properties: {
		in: { type: 'number' },
		hold: { type: 'number' },
		out: { type: 'number' }
	}
}

export const EDITOR_OPS_SCHEMA = {
	type: 'object',
	properties: {
		answer: {
			type: 'string',
			description: 'Only when the request is a question — answer it and propose no operations'
		},
		rationale: {
			type: 'string',
			description: 'Plain-language explanation of the proposed edit, citing what is in the pieces'
		},
		// A STRING on purpose, parsed by parseTargetLength. As a bare number this
		// field reliably digit-looped under constrained decoding ("targetLengthSec":
		// 120.05221111111... / 1200000000...) until MAX_TOKENS — observed repeatedly
		// on gemini-3-flash-preview at temperatures 0.2 AND 0.7. A string terminates
		// with a quote, and integer-typing is no fix (the grammar then forbids the
		// intended "120.0" and the model appends digits instead: it answered 12000).
		targetLength: {
			type: 'string',
			description: 'The output runtime you inferred from the request, BEFORE building the edit — minutes:seconds like "2:00", or plain seconds like "120"'
		},
		removeItemIds: { type: 'array', items: { type: 'string' } },
		closeGaps: {
			type: 'boolean',
			description: 'Pull every clip left so each track runs back to back with no gaps. Use when the user reports a gap or empty space in the timeline.'
		},
		updateItems: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					timelineStart: { type: 'number' },
					in: { type: 'number' },
					out: { type: 'number' },
					speed: { type: 'number' },
					label: { type: 'string' },
					gain: { type: 'number' },
					fadeInSec: { type: 'number' },
					fadeOutSec: { type: 'number' },
					transform: {
						type: 'object',
						description: 'Move, scale or rotate this clip inside the frame. x/y are fractions of the frame from centre; scale 1 is untouched; rotation in degrees.',
						properties: {
							x: { type: 'number' },
							y: { type: 'number' },
							scale: { type: 'number' },
							rotation: { type: 'number' }
						}
					},
					framing: {
						type: 'object',
						description: 'Only matters when the clip and the sequence are different shapes. fit letterboxes, fill crops; pan -1..1 chooses which part of a filled clip survives.',
						properties: {
							mode: { type: 'string', enum: ['fit', 'fill'] },
							pan: { type: 'number' }
						},
						required: ['mode']
					},
					key: {
						type: 'object',
						description: 'Remove this clip’s background so it sits IN FRONT of the layer below. Only meaningful on a clip above another video track. chroma removes a colour (green screen); luma removes the dark end (footage shot on black).',
						properties: {
							kind: { type: 'string', enum: ['chroma', 'luma'] },
							colour: { type: 'string', description: '#RRGGBB of the screen, for chroma' },
							similarity: { type: 'number', description: '0-1, how far from the colour still counts' },
							blend: { type: 'number', description: '0-1 edge softness' },
							despill: { type: 'number', description: '0-1, how much of the screen colour to pull out of the edges' }
						},
						required: ['kind']
					},
					layerRole: {
						type: 'string',
						enum: ['subject', 'background', 'overlay'],
						description: 'What this clip is FOR in a stacked shot. Descriptive; it does not change the render.'
					}
				},
				required: ['id']
			}
		},
		setTransitions: {
			type: 'array',
			description: 'Put a transition on the cut AFTER an item. Use "none" as the kind to remove one.',
			items: {
				type: 'object',
				properties: {
					afterItemId: { type: 'string', description: 'The OUTGOING clip — the transition sits on the cut at its end' },
					kind: { type: 'string', description: 'A transition kind from the AVAILABLE TRANSITIONS list, or "none"' },
					durationSec: { type: 'number', description: 'Seconds, 0.1-5. Shortened automatically when the clips are too short.' }
				},
				required: ['afterItemId', 'kind']
			}
		},
		applyLook: {
			type: 'array',
			description: 'Add a colour look or an audio repair to clips. Appends, so calling twice stacks two.',
			items: {
				type: 'object',
				properties: {
					itemIds: { type: 'array', items: { type: 'string' } },
					kind: { type: 'string', description: 'An effect kind from the AVAILABLE EFFECTS list' },
					params: {
						type: 'object',
						description: 'Parameter values for that effect. Omit to use its neutral defaults.',
						properties: {
							amount: { type: 'number' },
							intensity: { type: 'number' },
							radius: { type: 'number' },
							degrees: { type: 'number' },
							kelvin: { type: 'number' },
							hz: { type: 'number' },
							strength: { type: 'number' },
							ratio: { type: 'number' }
						}
					}
				},
				required: ['itemIds', 'kind']
			}
		},
		clearLooks: {
			type: 'array',
			description: 'Item ids to strip every effect from.',
			items: { type: 'string' }
		},
		addTitles: {
			type: 'array',
			description: 'Text burned onto the picture. Position and size are fractions of the frame.',
			items: {
				type: 'object',
				properties: {
					text: { type: 'string' },
					atSec: { type: 'number', description: 'Timeline seconds where it appears' },
					durationSec: { type: 'number', description: 'How long it stays up (default 3)' },
					x: { type: 'number', description: '0 left, 0.5 centre, 1 right (default 0.5)' },
					y: { type: 'number', description: '0 top, 1 bottom (default 0.85)' },
					size: { type: 'number', description: 'Cap height as a fraction of frame height (default 0.07)' }
				},
				required: ['text', 'atSec']
			}
		},
		removeRanges: {
			type: 'array',
			description: 'Cut spans of TIMELINE time out, splitting a clip when the span falls inside it. Use this to remove a sentence or a stumble without removing the whole piece it sits in. Timeline seconds, not source seconds.',
			items: {
				type: 'object',
				properties: {
					fromSec: { type: 'number' },
					toSec: { type: 'number' }
				},
				required: ['fromSec', 'toSec']
			}
		},
		addBackgrounds: {
			type: 'array',
			description: 'Add a synthesised background — a gradient or a colour — on its own track below everything. This is what a keyed clip sits in front of.',
			items: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: ['solid', 'gradient', 'bars', 'noise'] },
					colour: { type: 'string', description: '#RRGGBB' },
					colour2: { type: 'string', description: '#RRGGBB, the second colour of a gradient' },
					atSec: { type: 'number' },
					durationSec: { type: 'number' }
				}
			}
		},
		addMotion: {
			type: 'array',
			description: 'Add a motion graphic — a lower third, a title card, a stat — from AVAILABLE MOTION TEMPLATES, or write your own page (`template: "custom"` with `html`). It goes on a motion track above the footage.',
			items: {
				type: 'object',
				properties: {
					template: { type: 'string', description: 'A template id from AVAILABLE MOTION TEMPLATES, or "custom" when you write the page in `html`' },
					html: MOTION_HTML_SCHEMA,
					atSec: { type: 'number', description: 'Timeline seconds where it starts. Land it on the beat it belongs to — the word, not after it.' },
					durationSec: { type: 'number', description: 'How long it stays. Omit for the template’s own length.' },
					settings: MOTION_SETTINGS_SCHEMA,
					moments: MOTION_MOMENTS_SCHEMA,
					label: { type: 'string' }
				},
				required: ['template', 'atSec']
			}
		},
		updateMotion: {
			type: 'array',
			description: 'Change a motion layer already on the timeline (an item listed with `motion`): its text and colours, its in/hold/out windows, when it starts and how long it stays, or — with `html` — the page itself.',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					html: MOTION_HTML_SCHEMA,
					settings: MOTION_SETTINGS_SCHEMA,
					moments: MOTION_MOMENTS_SCHEMA,
					atSec: { type: 'number' },
					durationSec: { type: 'number' }
				},
				required: ['id']
			}
		},
		captions: {
			type: 'boolean',
			description: 'Burn the spoken transcript into the picture as captions. Only useful when a clip has been transcribed.'
		},
		loudness: {
			type: 'boolean',
			description: 'Normalise the finished mix to -14 LUFS, the level streaming platforms expect.'
		},
		addSceneRanges: {
			type: 'array',
			description: 'Bulk-add whole spans of pieces. This is how you build a full-length cut.',
			items: {
				type: 'object',
				properties: {
					assetId: { type: 'string' },
					fromScene: { type: 'integer', minimum: 0, maximum: 1000000, description: 'First piece # to include (inclusive)' },
					toScene: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Last piece # to include (inclusive)' },
					excludeScenes: {
						type: 'array',
						items: { type: 'integer', minimum: 0, maximum: 1000000 },
						description: 'Piece #s inside the span to SKIP (dead air, false starts, retakes)'
					},
					speed: { type: 'number', description: 'Playback rate 0.25-4.0 for the whole span (default 1)' },
					merge: { type: 'boolean', description: 'Default true: adjacent kept pieces become one clip' },
					atSec: { type: 'number' },
					afterItemId: { type: 'string' },
					label: { type: 'string' }
				},
				required: ['assetId', 'fromScene', 'toScene']
			}
		},
		addClips: {
			type: 'array',
			description: 'Add a few individual pieces. For long spans use addSceneRanges instead.',
			items: {
				type: 'object',
				properties: {
					assetId: { type: 'string' },
					sceneIndex: { type: 'integer', minimum: 0, maximum: 1000000, description: "A piece # from that asset's AVAILABLE SCENES table" },
					in: { type: 'number' },
					out: { type: 'number' },
					atSec: { type: 'number' },
					afterItemId: { type: 'string' },
					label: { type: 'string' }
				},
				required: ['assetId']
			}
		},
		addMarkers: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					atSec: { type: 'number', description: 'Timeline seconds. Use for material already on the timeline.' },
					atScene: {
						type: 'object',
						description: 'Anchor to a source piece instead — resolved to timeline time after your clips are placed. Use this when you are ADDING the material in this same response.',
						properties: {
							assetId: { type: 'string' },
							sceneIndex: { type: 'integer', minimum: 0, maximum: 1000000 }
						},
						required: ['assetId', 'sceneIndex']
					},
					label: { type: 'string' }
				},
				required: ['label']
			}
		}
	}
}

/**
 * The persona's house style, as instruction.
 *
 * Preferences, not a whitelist — the catalogues are listed in full elsewhere in
 * the context, and a persona that could only reach four transitions would be a
 * worse editor than one that knows which four it likes. The point is that a
 * user should not have to re-describe a house style in every prompt.
 */
function personaStyleLines(persona: EditorPersona): string[] {
	const style = persona.style
	if (!style) return []
	const lines: string[] = []
	if (style.note) lines.push(`House style: ${style.note}`)
	if (style.transitions?.length) {
		lines.push(`Preferred transitions: ${style.transitions.join(', ')} — reach for these first.`)
	}
	if (style.looks?.length) {
		lines.push(`Signature looks: ${style.looks.join(', ')}.`)
	}
	if (style.captions !== undefined) {
		lines.push(style.captions
			? 'Captions belong on this kind of edit — set `captions: true` when the material has a transcript.'
			: 'This kind of edit is not usually captioned; leave `captions` alone unless asked.')
	}
	if (style.loudness) {
		lines.push('Set `loudness: true` — this is meant to be posted.')
	}
	lines.push('These are this voice\'s habits, not limits. Anything in the catalogues is available.')
	return lines
}

// ===== System instruction composition =====

/** Project facts the contract quotes back at the model so it knows what "full length" means. */
export interface PromptStats {
	timelineItemCount: number
	timelineDurationSec: number
	sourceDurationSec: number   // 0 when unknown
	sourceClipCount: number
}

const clock = (seconds: number): string => {
	const total = Math.max(0, Math.round(seconds))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Tell the model to work out the intended runtime from the REQUEST.
 *
 * This replaces a persona-driven `targetDurationSec`. The old summarize branch
 * hard-set a number, and the old longform branch hard-forbade shortening ("if
 * your cut comes to less than 70% you have cut too much"). Both fought the user
 * whenever the request disagreed with the persona.
 *
 * What survives from that guardrail is the reason it existed: models over-cut by
 * default. So the instruction still demands a self-check — but against the
 * length the model itself inferred, not against a constant. It reports that
 * number in `targetLength` so the UI can hold it to its word.
 *
 * The empty-timeline vs existing-cut split stays: that was always keyed on
 * timeline state, never on persona mode.
 */
function outputLengthLines(stats: PromptStats, phase?: 'survey' | 'detail'): string[] {
	const haveSource = stats.sourceDurationSec > 0

	const preamble = [
		'=== OUTPUT LENGTH ===',
		'Nothing here presets a runtime. Work out the intended length from the request:',
		'- It names a length, or a format with a conventional length ("cut this to 2 minutes",',
		'  "a 30-second teaser", "a short for socials") — hit it.',
		'- It is about CLEANING, TIGHTENING, FIXING, ORGANIZING or CHAPTERING ("remove the',
		'  filler", "clean up the dead air", "add chapters") — that is NOT a request to',
		'  shorten. Keep the runtime, minus only what was asked for.',
		'- It says nothing about length — use the default below.',
		// One field, one job. An earlier wording ("...and open your rationale with
		// it") taught the model to fuse both fields into one unterminated string
		// ("targetLength": "2:00Targeting about 2:00 — ...") that ran to MAX_TOKENS.
		'Report the runtime you settled on in `targetLength` — JUST the duration, like "2:00".',
		'Keep `rationale` to a few sentences.',
		'Before finishing, add up the runtime you are actually producing and compare it with',
		'that target. If it is more than ~25% short, you have dropped material you meant to',
		'keep: go back and include it. Coming in far under the intended length is by far the',
		'most common failure — when in doubt, include more.',
		'The persona above describes a STYLE. Where the request implies a different length',
		'than the persona\'s usual habit, the request wins.'
	]

	// Empty timeline: there is no runtime to preserve — it has to be BUILT.
	if (stats.timelineItemCount === 0) {
		// Giving the model the actual piece length lets it size a short cut by
		// arithmetic instead of guessing. Guessing cost a MAX_TOKENS failure: asked
		// for 2 minutes it listed hundreds of addClips entries and truncated.
		const avgPieceSec = stats.sourceClipCount > 0
			? stats.sourceDurationSec / stats.sourceClipCount
			: 0
		if (!haveSource) {
			return [
				...preamble,
				'',
				'The timeline is EMPTY, so you are building this cut from scratch. Default when the',
				'request does not ask for something shorter: cover the available source end to end in',
				'chronological order, removing only dead air, silence, false starts and duplicated takes.'
			]
		}
		// The SHORT bullet must match what the model can actually see: in the
		// survey pass the gists cannot support picking individual pieces, so the
		// arithmetic there would be an instruction to curate blind (the critique
		// bd5e682 earned: contradictory prose loses to the schema every time).
		const shortBullet = phase === 'survey'
			? [
				`- Aiming SHORT (a highlight, teaser, trailer, short): pieces here average about`,
				`  ${avgPieceSec.toFixed(1)}s, so a T-second target needs roughly T/${avgPieceSec.toFixed(1)} pieces — but do NOT pick`,
				'  pieces you have not read. Respond with `expandRegions` and no edit operations,',
				'  naming the strongest spans from the survey; you will then see them one row per',
				'  piece and make the cut.'
			]
			: [
				`- Aiming SHORT (a highlight, teaser, trailer, short): pieces here average about`,
				`  ${avgPieceSec.toFixed(1)}s, so a T-second target needs roughly T/${avgPieceSec.toFixed(1)} pieces — do that arithmetic`,
				'  before you start and add about that many, no more. Pick them with `addClips`, or use a',
				'  few narrow `addSceneRanges` around the moments you want. Never list more than ~40',
				'  entries: past that you will hit the response limit mid-answer and the whole edit is lost.'
			]
		const longBullet = [
			'- Aiming LONG (the full thing, a cleanup, a polish): cover the source end to end in',
			'  chronological order with `addSceneRanges` over whole spans of piece numbers, using',
			'  `excludeScenes` for what you drop — typically 5-20% of the runtime. Do NOT list kept',
			'  pieces one by one; you will run out of response length long before the end.',
			...(phase === 'survey' ? [
				'  The [sil #idx(secs)] entries and [Silence xN] rows name the dead-air piece numbers —',
				'  copy them into `excludeScenes`.'
			] : [])
		]
		return [
			...preamble,
			'',
			`The timeline is EMPTY, so you are building this cut from scratch out of about`,
			`${clock(stats.sourceDurationSec)} of footage across ${stats.sourceClipCount} detected pieces.`,
			'There is nothing on the timeline yet, so there is nothing to update, remove or retime:',
			'`updateItems` and `removeItemIds` CANNOT apply here and will be discarded. Your only job',
			'this turn is to ADD material, with `addSceneRanges` and/or `addClips`.',
			...shortBullet,
			...longBullet,
			'Default when the request does not ask for something shorter: aim LONG.'
		]
	}

	// Existing cut: default is to keep its runtime.
	const lines = [
		...preamble,
		'',
		`The current cut is ${stats.timelineItemCount} items, ${clock(stats.timelineDurationSec)}. Default when the request does not`,
		'ask for a different length: PRESERVE that runtime. Make editorial improvements (remove dead',
		'air, tighten with retime, reorder, chapter) without shrinking the substantive content. Edit',
		'the items that are already there; do not rebuild the timeline from scratch.'
	]
	if (haveSource && stats.timelineDurationSec < 0.7 * stats.sourceDurationSec) {
		lines.push(
			`The current cut (${clock(stats.timelineDurationSec)}) is far shorter than the source available to you`,
			`(${clock(stats.sourceDurationSec)}). If the user asks you to extend, lengthen, continue or complete it,`,
			'APPEND the missing material with `addSceneRanges` — do not re-cut what is already there.'
		)
	}
	return lines
}

/**
 * Offered only in pass 1 of a survey-band turn (see routeSurveyResponse).
 * The pass-2 schema omits it, so a turn is structurally at most two calls.
 */
const EXPAND_REGIONS_SCHEMA = {
	type: 'array',
	description:
		'Spans of pieces to READ one row per piece before you decide. Use this when the edit ' +
		'hinges on exact wording the survey gists cannot show (a short highlight, a precise trim). ' +
		`Return up to ${EXPAND_MAX_REGIONS} spans, together at most ~${DETAIL_MAX_PIECES} pieces, ` +
		'with NO edit operations and no answer — you will be called again with those spans ' +
		'expanded. rationale and targetLength are welcome alongside.',
	items: {
		type: 'object',
		properties: {
			assetId: { type: 'string' },
			fromPiece: { type: 'integer', minimum: 0, maximum: 1000000, description: 'First piece # to read (inclusive, clamped)' },
			toPiece: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Last piece # to read (inclusive, clamped)' },
			reason: { type: 'string', description: 'A few words: what you expect to find there' }
		},
		required: ['assetId', 'fromPiece', 'toPiece']
	}
}

/**
 * The ops schema for one turn.
 *
 * On an EMPTY timeline the item-mutating ops are removed rather than merely
 * discouraged. Observed failure: asked for a 2-minute highlight of a 92-minute
 * source with nothing on the timeline, the model emitted `updateItems` against
 * invented ids ("highlight_1", "v1_0") and added nothing — it read updateItems
 * as "declare the items of my output". Prose in the contract did not fix it;
 * removing the option does, because there is genuinely nothing to update,
 * remove or close gaps between until something has been added.
 *
 * `offerExpandRegions` follows the same removal-beats-prose lesson in the other
 * direction: the detail-pass escape hatch exists as a schema option only in the
 * one call that may use it.
 */
export function editorOpsSchema(hasTimelineItems: boolean, offerExpandRegions = false) {
	let properties = EDITOR_OPS_SCHEMA.properties as any
	if (!hasTimelineItems) {
		const { removeItemIds, closeGaps, updateItems, updateMotion, ...buildOnly } = properties
		properties = buildOnly
	}
	if (offerExpandRegions) {
		properties = { ...properties, expandRegions: EXPAND_REGIONS_SCHEMA }
	}
	return {
		...EDITOR_OPS_SCHEMA,
		properties,
		propertyOrdering: PROPERTY_ORDERING.filter((name) => name in properties)
	}
}

// ===== Survey-band routing (pass 1 -> final | detail pass) =====

export type SurveyRoute =
	| { kind: 'final'; ops: EditorOps; note?: string }
	| { kind: 'expand'; regions: NonNullable<EditorOps['expandRegions']>; note?: string }

/**
 * Which way pass 1 of a survey-band turn goes. An `answer` always wins — a
 * question never needs detail it did not read. After that the tie-break for a
 * hedged response (regions AND ops in one reply) is keyed on timeline state:
 *
 * - EMPTY timeline: the region request wins and the ops are set aside. A
 *   build-from-scratch that commits without reading detail is exactly the
 *   blind coarse cut the detail pass exists to prevent, so hedging must not
 *   let it slip through.
 * - Existing timeline: real ops win and the read is skipped. Discarding a
 *   completed cleanup to re-run it at detail granularity would double-bill
 *   the turn for nothing — the edit was already expressible from the survey.
 */
export function routeSurveyResponse(
	ops: EditorOps | null | undefined,
	hasTimelineItems: boolean
): SurveyRoute {
	const response = ops || {}
	const regions = response.expandRegions || []
	const hasEditOps = !!(
		response.removeItemIds?.length || response.updateItems?.length ||
		response.addClips?.length || response.addSceneRanges?.length ||
		response.closeGaps || response.addMarkers?.length
	)
	if (response.answer?.trim() || !regions.length) {
		return {
			kind: 'final',
			ops: response,
			note: response.answer?.trim() && regions.length
				? 'The model answered the question and also asked to read spans in detail — the answer stands.'
				: undefined
		}
	}
	if (!hasTimelineItems) {
		return {
			kind: 'expand',
			regions,
			note: hasEditOps
				? 'Draft operations proposed before reading detail were set aside; the edit was re-decided over the expanded spans.'
				: undefined
		}
	}
	if (hasEditOps) {
		return {
			kind: 'final',
			ops: response,
			note: 'The model both edited and asked to read spans in detail — the edit was applied and the extra read skipped.'
		}
	}
	return { kind: 'expand', regions }
}

/**
 * "2:00" | "120" | "120.5" | "1:02:03" -> seconds. Anything unparseable,
 * non-positive, or past 24h (a digit-run artifact like "12000000...") is
 * treated as not-reported rather than clamped: a fabricated target would make
 * measureBuild judge the cut against garbage.
 */
export function parseTargetLength(value: string | undefined | null): number | undefined {
	if (typeof value !== 'string') return undefined
	const text = value.trim()
	if (!text) return undefined
	let seconds: number
	if (text.includes(':')) {
		const parts = text.split(':')
		if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined
		seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
	} else {
		if (!/^\d+(\.\d+)?$/.test(text)) return undefined
		seconds = Number(text)
	}
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) return undefined
	return seconds
}

/** Field-wise sum, for a turn that spent more than one model call. */
export function sumUsage(usages: Usage[]): Usage {
	const total: Usage = { promptTokens: 0, candidatesTokens: 0, thinkingTokens: 0, totalTokens: 0 }
	for (const usage of usages) {
		total.promptTokens += usage.promptTokens || 0
		total.candidatesTokens += usage.candidatesTokens || 0
		total.thinkingTokens = (total.thinkingTokens || 0) + (usage.thinkingTokens || 0)
		total.totalTokens += usage.totalTokens || 0
	}
	return total
}

/**
 * `phase` is set only on survey-band turns (large sources): 'survey' for the
 * first call (condensed table, expandRegions offered), 'detail' for the second
 * (requested spans expanded, expandRegions gone). Omitted on small sources —
 * the output is then byte-identical to the pre-banding instruction.
 */
export function composeSystemInstruction(
	persona: EditorPersona,
	stats: PromptStats,
	phase?: 'survey' | 'detail'
): string {
	const defaults = persona.defaults || {}

	const phaseLines = phase === 'survey'
		? [
			'',
			'=== LONG SOURCE: CONDENSED SURVEY (this call) ===',
			'This project is too large to show every transcript line at once, so AVAILABLE',
			'SCENES is a condensed survey — its header explains the row format. Decide what',
			'this turn needs:',
			'- A question: answer it now in `answer`.',
			// The middle bullet must agree with the OUTPUT LENGTH branch above it:
			// "cover the source with addSceneRanges" is build-from-scratch advice,
			// and on an existing cut it reads as "rebuild", which SourceCoverage
			// would turn into a no-op or an unwanted append.
			...(stats.timelineItemCount === 0
				? [
					'- A full-length cut, cleanup or reorganization: build it NOW with `addSceneRanges`',
					'  spans, copying dead-air piece #s from the [sil ...] cells and [Silence xN] rows',
					'  into `excludeScenes`. You do not need per-piece detail for this.'
				]
				: [
					'- A cleanup, tightening or reorganization of the EXISTING cut: edit the placed',
					'  items NOW with `updateItems`/`removeItemIds`, as the length rules above say.',
					'  Use `addSceneRanges` only to APPEND material that is not on the timeline yet.'
				]),
			'- A SHORT cut, or any edit that hinges on exact wording the gists cannot show:',
			'  respond with `expandRegions` and NO edit operations — you will make the edit',
			'  on the next call. (`rationale` and `targetLength` are still welcome.)'
		]
		: phase === 'detail'
			? [
				'',
				'=== DETAIL VIEW (second call) ===',
				'You asked to read the spans listed under DETAIL VIEW; they now appear one row per',
				'piece. Build the edit NOW — `expandRegions` is not available in this response.',
				'Prefer pieces you can read; `addSceneRanges` endpoints may still name any piece #.'
			]
			: []

	return [
		persona.systemPrompt,
		'',
		'=== EDITOR CONTRACT (always applies) ===',
		'You are proposing an edit to a video timeline in a non-linear editor. You receive the',
		"current timeline items (each with a stable id), the project's media assets with their",
		'detected pieces, and a user request.',
		'- If the request is a QUESTION about the project, put the answer in `answer` and',
		'  propose no operations.',
		'- Otherwise propose ONE coherent edit:',
		'  - Reference existing timeline items ONLY by their exact `id` from the items list.',
		'  - Add new material with `addSceneRanges` (bulk, preferred) or `addClips` (a few',
		'    individual pieces). `addClips` entries are placed BEFORE `addSceneRanges` entries;',
		'    to build one ordered assembly put EVERYTHING in `addSceneRanges` and use',
		'    fromScene === toScene for a single piece.',
		'  - `addSceneRanges` adds every piece from `fromScene` to `toScene` of one asset minus',
		'    `excludeScenes`, and merges adjacent kept pieces into as few clips as possible. ONE',
		'    range can add thousands of pieces — this is how you build a full-length cut without',
		'    listing every piece.',
		'  - Ranges never duplicate footage: any part of a piece already on the timeline is trimmed',
		'    out automatically, so it is safe to give a generous span when continuing a cut. To',
		'    deliberately repeat a moment, use `addClips`.',
		'  - Piece numbers: `addClips.sceneIndex` must be a real # from the AVAILABLE SCENES table.',
		'    `addSceneRanges` endpoints are the ONE exception — fromScene / toScene are CLAMPED to',
		"    the asset's real range, so \"fromScene: 1, toScene: 99999\" safely means \"to the end\".",
		'    `excludeScenes` entries outside the span are ignored. Never invent item ids, asset ids,',
		'    or `addClips` piece numbers.',
		'  - Placement: omit `atSec` and clips append in order with no gaps. Set `atSec` only for a',
		'    deliberate absolute position — a large `atSec` pushes every later append after it.',
		'    `afterItemId` may name only an item that ALREADY exists on the timeline, never one you',
		'    are adding in this same response.',
		'  - `updateItems` may change timelineStart, in, out, speed (0.25-4.0), label,',
		'    gain (0-2, audio mix level), and fadeInSec / fadeOutSec (audio fade lengths, seconds).',
		'    Never set durations — they are derived from (out - in) / speed.',
		'  - Only modify items listed in the items section.',
		'  - Gaps: removing, retiming or trimming clips ALREADY pulls the rest of the track',
		'    left to fill the time freed, so NEVER rewrite timelineStart to close a hole —',
		'    doing so turns the automatic layout off and is how gaps get left behind. Set',
		'    timelineStart only to move a clip somewhere deliberately. If the user reports a',
		'    gap or empty space already on the timeline, set `closeGaps: true`.',
		'  - Chapter markers: use `atScene` when the material is being added in this response',
		'    (you cannot know its timeline time yet), `atSec` when it is already on the timeline.',
		'  - Order material by the `recorded` window in the asset list when one is shown, not by',
		'    the order the assets happen to be listed in. Fall back to filenames only when no',
		'    recorded window is given.',
		'  - Look and sound (use sparingly — a cut nobody asked to be graded should not be):',
		'    `setTransitions` puts a transition on the cut AFTER a clip; it is shortened',
		'    automatically when the clips are too short, so ask for what you want. `applyLook`',
		'    adds a colour look or an audio repair and APPENDS, so two calls stack.',
		'    `clearLooks` strips a clip back. Kinds must come from the AVAILABLE lists —',
		'    an invented one is dropped.',
		'  - `updateItems.transform` moves, scales and rotates a clip inside the frame; x/y are',
		'    fractions of the frame from centre and scale 1 is untouched. `framing` only matters',
		'    when the clip and the sequence are different shapes.',
		'  - Layers: a clip on a HIGHER video track composites over the one below it.',
		'    `updateItems.key` removes a clip’s background so it sits IN FRONT rather than',
		'    covering everything, and `addBackgrounds` makes something for it to sit in front',
		'    of. Combine with `transform` for a picture-in-picture. Only worth doing when the',
		'    material actually suits it — a key on ordinary footage removes the wrong thing.',
		'  - `removeRanges` cuts spans of TIMELINE time out, splitting a clip where the span falls',
		'    inside it. This is how you remove one sentence, a stumble or a repeated take without',
		'    losing the whole piece around it. Use `removeItemIds` when a whole piece should go.',
		'  - `addMotion` places a motion graphic from AVAILABLE MOTION TEMPLATES — a lower third',
		'    when someone introduces themselves, a stat card when a number is said, a chapter card',
		'    at a turn in the story. Time it to the words: start it on the beat, and set the `out`',
		'    window to finish before the next shot. `updateMotion` retimes or rewrites one that is',
		'    already placed. Prefer these over `addTitles` for anything designed.',
		'    When no template fits, write the page: `addMotion` with `template: "custom"` and `html`,',
		'    or `updateMotion` with `html` to rewrite a custom layer. A page calls',
		'    frameflow.define({ duration, settings: [{ key, type: number|text|color|enum, default,',
		'    animate? }], moments: [{ name, duration, flex? }], seek(t, settings) }) and draws ONLY',
		'    from t and settings: no CSS animation or transition, setTimeout, requestAnimationFrame,',
		'    Date.now, Math.random, fetch or remote URLs. Helpers: frameflow.progress("in", t) is 0..1',
		'    across a moment; frameflow.ease.out/inOut/back, frameflow.lerp, frameflow.clamp. Inter and',
		'    Outfit are bundled. A page that breaks these rules is not drawn — the last version that',
		'    passed stays, and the result says why.',
		'  - `addTitles` puts text on the picture. `captions: true` burns the spoken transcript',
		'    in, and only helps when the material has actually been transcribed.',
		'    `loudness: true` normalises the mix to the level streaming platforms expect —',
		'    a safe finishing touch on anything meant to be posted.',
		'- Always include a short `rationale` describing what you changed and why, citing what is',
		'  actually in the pieces.',
		'',
		'=== ACTIVE PERSONA DEFAULTS ===',
		`Tone: ${persona.tone || 'neutral'}. Pacing: ${defaults.pacing || 'balanced'}.`,
		...personaStyleLines(persona),
		...outputLengthLines(stats, phase),
		...phaseLines
	].filter(Boolean).join('\n')
}

// ===== Ops -> TimelineDiff mapping =====

/**
 * Coalescing tolerances. The DEFAULT clip producer is the transcript
 * (deriveClipsFromTranscript), which only gap-fills gaps larger than
 * MIN_GAP_SEC = 0.5s and can emit slightly overlapping pieces, so the
 * detected-scene epsilon (CLIP_ADJACENCY_EPSILON = 0.1) is far too tight here.
 */
export const MERGE_GAP_TOL_SEC = 0.75
export const MERGE_OVERLAP_TOL_SEC = 0.25
/** Close a merged run past this much source so single items stay reviewable. */
export const MAX_MERGED_SOURCE_SEC = 300
/** Above this many expanded items, tell the user — but never drop content. */
export const EXPANSION_ADVISORY = 400
/** Runaway backstop. */
export const MAX_EXPANDED_ITEMS = 2000
export const MARKER_DEDUPE_SEC = 0.25

/** A trimmed piece is discarded below this, to avoid frame-sized slivers. */
export const MIN_TRIMMED_PIECE_SEC = 0.15

interface Placement {
	assetId: string
	srcIn: number
	srcOut: number
	tStart: number
	speed: number
}

/**
 * Which source seconds of each asset are already spoken for — by the existing
 * timeline and by everything added earlier in this same response.
 *
 * This is what keeps an assembly free of duplicated footage. It matters twice:
 * a continuation turn that re-adds material it already placed, and assets whose
 * transcript timestamps overlap (a Whisper repetition loop can emit pieces that
 * overlap their predecessor by seconds), which would otherwise put the same
 * audio on the timeline back to back.
 */
class SourceCoverage {
	private byAsset = new Map<string, { in: number; out: number }[]>()

	add(assetId: string, inSec: number, outSec: number): void {
		if (!(outSec > inSec)) return
		const spans = this.byAsset.get(assetId) || []
		spans.push({ in: inSec, out: outSec })
		spans.sort((a, b) => a.in - b.in)
		const merged: { in: number; out: number }[] = []
		for (const span of spans) {
			const last = merged[merged.length - 1]
			if (last && span.in <= last.out) last.out = Math.max(last.out, span.out)
			else merged.push({ ...span })
		}
		this.byAsset.set(assetId, merged)
	}

	/**
	 * EVERY still-uncovered slice of [inSec, outSec), in order. Returning only
	 * the longest one would silently drop the rest of the piece: a 20s piece
	 * with an existing item over 8-12s would contribute 0-8 and lose 12-20.
	 */
	freeSlices(assetId: string, inSec: number, outSec: number): { in: number; out: number }[] {
		if (!(outSec > inSec)) return []
		const spans = this.byAsset.get(assetId)
		if (!spans?.length) return [{ in: inSec, out: outSec }]

		const slices: { in: number; out: number }[] = []
		let cursor = inSec
		for (const span of spans) {
			if (span.out <= cursor) continue
			if (span.in >= outSec) break
			if (span.in > cursor) slices.push({ in: cursor, out: Math.min(span.in, outSec) })
			cursor = Math.max(cursor, span.out)
			if (cursor >= outSec) break
		}
		if (cursor < outSec) slices.push({ in: cursor, out: outSec })
		return slices.filter((s) => s.out - s.in >= MIN_TRIMMED_PIECE_SEC)
	}
}

interface Run {
	in: number
	out: number
	first: Clip
	firstIdx: number
	lastIdx: number
	count: number
}

export interface OpsToDiffResult {
	diff: TimelineDiff
	addMarkers: { time: number; label: string }[]
	/**
	 * Project settings the model asked for. They live outside TimelineState —
	 * like markers — so they ride beside the diff rather than inside it.
	 */
	docSettings: { captionsEnabled?: boolean; loudnessEnabled?: boolean }
	droppedOps: string[]
	notes: string[]
}

const labelFrom = (clip: Clip): string =>
	(clip.visual || clip.text)?.replace(/\s+/g, ' ').trim().slice(0, 40) || `Piece #${clip.index}`

export function opsToDiff(
	ops: EditorOps,
	doc: EditorDocument,
	/** Who is writing, for the "Written by …" line on a custom page. */
	writer: { by: string; turnId?: string } = { by: 'FrameFlow AI' }
): OpsToDiffResult {
	const droppedOps: string[] = []
	const notes: string[] = []
	const diff: TimelineDiff = { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }
	const itemIds = new Set(doc.timeline.map((i) => i.id))

	// Removals
	if (ops.removeItemIds?.length) {
		const known = ops.removeItemIds.filter((id) => itemIds.has(id))
		for (const id of ops.removeItemIds) {
			if (!itemIds.has(id)) droppedOps.push(`remove: unknown item ${id}`)
		}
		if (known.length) diff.removeItemIds = known
	}

	// Updates (whitelist fields; validation happens in applyTimelineDiff)
	if (ops.updateItems?.length) {
		const updates: NonNullable<TimelineDiff['updateItems']> = []
		for (const update of ops.updateItems) {
			if (!itemIds.has(update.id)) {
				droppedOps.push(`update: unknown item ${update.id}`)
				continue
			}
			const clean: { id: string } & Partial<TimelineItem> = { id: update.id }
			if (typeof update.timelineStart === 'number') clean.timelineStart = update.timelineStart
			if (typeof update.in === 'number') clean.in = update.in
			if (typeof update.out === 'number') clean.out = update.out
			if (typeof update.speed === 'number') clean.speed = update.speed
			if (typeof update.label === 'string') clean.label = update.label
			// Audio adjustments — clamped again in applyTimelineDiff's normalize
			if (typeof update.gain === 'number') clean.gain = Math.max(0, Math.min(2, update.gain))
			if (typeof update.fadeInSec === 'number') clean.fadeInSec = Math.max(0, update.fadeInSec)
			if (typeof update.fadeOutSec === 'number') clean.fadeOutSec = Math.max(0, update.fadeOutSec)
			// Everything below is clamped by the same shared code the UI uses, so
			// a model cannot reach a value a person could not.
			if (update.transform) {
				const t = update.transform
				const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
					typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
				const next = {
					x: clamp(t.x, OFFSET_RANGE.min, OFFSET_RANGE.max, 0),
					y: clamp(t.y, OFFSET_RANGE.min, OFFSET_RANGE.max, 0),
					scale: clamp(t.scale, SCALE_RANGE.min, SCALE_RANGE.max, 1),
					rotation: clamp(t.rotation, -360, 360, 0)
				}
				clean.transform = hasTransform(next) ? next : undefined
			}
			if (update.framing) {
				clean.framing = update.framing.mode === 'fill'
					? { mode: 'fill' as const, pan: clampPan(update.framing.pan) }
					: undefined
			}
			if (update.key) {
				// The shared clamps again: a model cannot reach a key a person
				// could not set with the sliders.
				const unit = (n: unknown, fallback: number) =>
					typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
				clean.key = update.key.kind === 'chroma' || update.key.kind === 'luma'
					? {
						kind: update.key.kind,
						colour: update.key.colour || KEY_DEFAULTS.colour,
						similarity: unit(update.key.similarity, KEY_DEFAULTS.similarity),
						blend: unit(update.key.blend, KEY_DEFAULTS.blend),
						despill: unit(update.key.despill, KEY_DEFAULTS.despill)
					}
					: undefined
			}
			if (update.layerRole && ['subject', 'background', 'overlay'].includes(update.layerRole)) {
				clean.layerRole = update.layerRole
			}
			if (Object.keys(clean).length > 1) updates.push(clean)
		}
		if (updates.length) diff.updateItems = updates
	}

	// Sub-clip removals. Folded into the same removeItemIds/updateItems the rest
	// of this function speaks, so everything downstream — ripple, revisions,
	// undo — treats a cut sentence exactly like a deleted clip.
	if (ops.removeRanges?.length) {
		const survivors = doc.timeline.filter((i) => !diff.removeItemIds?.includes(i.id))
		const plan = planRangeRemoval(
			survivors,
			ops.removeRanges.map((r) => ({ start: r.fromSec, end: r.toSec })),
			() => uuidv4()
		)
		if (!plan.removedSec) {
			droppedOps.push('removeRanges: nothing on the timeline in those spans')
		} else {
			if (plan.removeIds.length) {
				diff.removeItemIds = [...(diff.removeItemIds || []), ...plan.removeIds]
			}
			for (const shaped of plan.updated) {
				const updates = (diff.updateItems ||= [])
				const existing = updates.find((u) => u.id === shaped.id)
				const fields = {
					timelineStart: shaped.timelineStart, in: shaped.in, out: shaped.out,
					duration: shaped.duration, masterSegmentIndex: undefined,
					...(shaped.transition === undefined ? { transition: undefined } : {})
				}
				if (existing) Object.assign(existing, fields)
				else updates.push({ id: shaped.id, ...fields })
			}
			if (plan.added.length) diff.addItems = [...(diff.addItems || []), ...plan.added]
			notes.push(`Cut ${plan.removedSec.toFixed(1)}s from inside ${
				plan.updated.length + plan.removeIds.length} clip(s).`)
		}
	}

	// ===== Adds: one phase, one cursor, ids generated HERE and never by the model =====
	const adds: TimelineItem[] = []
	const placements: Placement[] = []
	// Source already on the timeline, minus anything this edit removes.
	const removed = new Set(diff.removeItemIds || [])
	const coverage = new SourceCoverage()
	for (const item of doc.timeline) {
		if (!removed.has(item.id)) coverage.add(item.sourceAssetId, item.in, item.out)
	}
	const targetTrack = [...doc.tracks]
		.sort((a, b) => a.order - b.order)
		.find((t) => t.kind === 'video' && !t.locked && !t.hidden)

	// Sequential placement cursor for adds without explicit position. Only the
	// TARGET track's SURVIVING items count: measuring every track would park the
	// whole assembly after a music bed on the audio track (an export that opens
	// with minutes of black), and counting items this edit removes would leave a
	// hole where they used to be.
	let appendCursor = computeContentEnd(
		doc.timeline.filter((i) => i.trackId === targetTrack?.id && !removed.has(i.id))
	)

	/** Explicit atSec > after a known item > append at end. */
	const positionFor = (add: { atSec?: number; afterItemId?: string }): number => {
		if (typeof add.atSec === 'number' && add.atSec >= 0) return add.atSec
		if (add.afterItemId && itemIds.has(add.afterItemId)) {
			return itemEnd(doc.timeline.find((i) => i.id === add.afterItemId)!)
		}
		return appendCursor
	}

	const pushItem = (item: TimelineItem) => {
		adds.push(item)
		coverage.add(item.sourceAssetId, item.in, item.out)
		placements.push({
			assetId: item.sourceAssetId,
			srcIn: item.in,
			srcOut: item.out,
			tStart: item.timelineStart,
			speed: item.speed || 1
		})
		// Keep the Math.max semantics: the cursor never moves backwards, so a stray
		// atSec pushes later appends after it rather than creating overlaps.
		appendCursor = Math.max(appendCursor, item.timelineStart + item.duration)
	}

	// --- addClips: individual pieces / explicit source ranges ---
	for (const add of ops.addClips || []) {
		const asset = doc.media.find((a) => a.id === add.assetId)
		if (!asset) {
			droppedOps.push(`add: unknown asset ${add.assetId}`)
			continue
		}
		if (!targetTrack) {
			droppedOps.push('add: no unlocked video track available')
			break
		}

		let sourceIn: number | undefined
		let sourceOut: number | undefined
		let sourceClipId: string | undefined
		let masterSegmentIndex: number | undefined
		let label = add.label

		if (typeof add.sceneIndex === 'number') {
			const clip = asset.clips.find((c) => c.index === add.sceneIndex)
			if (!clip) {
				droppedOps.push(`add: unknown piece #${add.sceneIndex} of ${asset.name}`)
				continue
			}
			sourceIn = clip.in
			sourceOut = clip.out
			sourceClipId = clip.id
			masterSegmentIndex = clip.masterSegmentIndex
			label = label || labelFrom(clip)
		} else if (typeof add.in === 'number' && typeof add.out === 'number') {
			const assetDuration = asset.metadata?.duration ?? Number.POSITIVE_INFINITY
			if (!(add.in >= 0 && add.out > add.in && add.out <= assetDuration + 0.01)) {
				droppedOps.push(`add: invalid range ${add.in}-${add.out} for ${asset.name}`)
				continue
			}
			sourceIn = add.in
			sourceOut = add.out
			label = label || asset.name
		} else {
			droppedOps.push(`add: neither sceneIndex nor in/out given for ${asset.name}`)
			continue
		}

		pushItem({
			id: uuidv4(),
			trackId: targetTrack.id,
			sourceAssetId: asset.id,
			sourceClipId,
			masterSegmentIndex,
			timelineStart: positionFor(add),
			in: sourceIn!,
			out: sourceOut!,
			speed: 1.0,
			preservePitch: true,
			duration: sourceOut! - sourceIn!,
			label
		})
	}

	// --- addSceneRanges: bulk spans, expanded into merged contiguous runs ---
	for (const range of ops.addSceneRanges || []) {
		const asset = doc.media.find((a) => a.id === range.assetId)
		if (!asset) {
			droppedOps.push(`range: unknown asset ${range.assetId}`)
			continue
		}
		if (!targetTrack) {
			droppedOps.push('range: no unlocked video track available')
			break
		}
		const clips = [...(asset.clips || [])].sort((a, b) => a.index - b.index)
		if (!clips.length) {
			droppedOps.push(`range: ${asset.name} has no detected pieces`)
			continue
		}

		let from = Math.round(range.fromScene)
		let to = Math.round(range.toScene)
		if (!Number.isFinite(from) || !Number.isFinite(to)) {
			droppedOps.push(`range: fromScene/toScene missing for ${asset.name}`)
			continue
		}
		if (from > to) [from, to] = [to, from]

		// CLAMP rather than drop: a dropped 1400-piece range would silently lose
		// most of the edit, while a clamped one is exactly what was meant.
		const minIdx = clips[0].index
		const maxIdx = clips[clips.length - 1].index
		const fromIdx = Math.max(minIdx, Math.min(maxIdx, from))
		const toIdx = Math.max(minIdx, Math.min(maxIdx, to))
		if (fromIdx !== from || toIdx !== to) {
			notes.push(`Range #${from}–#${to} of "${asset.name}" clamped to #${fromIdx}–#${toIdx}.`)
		}

		const excluded = new Set((range.excludeScenes || []).map((n) => Math.round(n)))
		// Filter by index VALUE, never by array slicing.
		const selected = clips.filter((c) => c.index >= fromIdx && c.index <= toIdx && !excluded.has(c.index))
		if (!selected.length) {
			droppedOps.push(`range: every piece in #${fromIdx}–#${toIdx} of ${asset.name} was excluded`)
			continue
		}

		// Trim every piece to the part of the source that is not already on the
		// timeline. Fully-covered pieces vanish; partially-covered ones shrink.
		// Done in index order so a piece also yields to its own predecessors.
		let alreadyCovered = 0
		const trimmed: { clip: Clip; in: number; out: number; whole: boolean }[] = []
		for (const clip of selected) {
			const free = coverage.freeSlices(asset.id, clip.in, clip.out)
			if (!free.length) {
				alreadyCovered++
				continue
			}
			// A piece can survive in more than one slice when covered material
			// sits in its middle; each free slice is placed.
			for (const slice of free) {
				coverage.add(asset.id, slice.in, slice.out)
				// `whole` records that nothing was trimmed off the FRONT. A slice
				// that starts late begins just after material already on the
				// timeline, so merging it into the previous run would stretch that
				// run back over the covered hole and replay it.
				trimmed.push({ clip, in: slice.in, out: slice.out, whole: slice.in === clip.in })
			}
		}
		if (alreadyCovered) {
			notes.push(`Skipped ${alreadyCovered} piece${alreadyCovered === 1 ? '' : 's'} of "${asset.name}" already on the timeline.`)
		}
		if (!trimmed.length) {
			droppedOps.push(`range: all of #${fromIdx}–#${toIdx} of ${asset.name} is already on the timeline`)
			continue
		}

		const runs: Run[] = []
		for (const { clip, in: clipIn, out: clipOut, whole } of trimmed) {
			const last = runs[runs.length - 1]
			const delta = last ? clipIn - last.out : Number.POSITIVE_INFINITY
			// Index adjacency is MANDATORY and not implied by the time test: an
			// excluded piece shorter than MERGE_GAP_TOL_SEC would otherwise be
			// silently swallowed back into the merged item's [in, out].
			// Safe to merge when nothing was trimmed off this slice's front, OR when
			// the trim was caused by the previous run itself (the slice starts
			// exactly where that run ends). A slice pushed forward past OTHER
			// covered material must start its own run, or the merged span would
			// stretch back over that material and replay it.
			const continuesRun = whole || (!!last && Math.abs(clipIn - last.out) <= 1e-6)
			const adjacent = !!last &&
				continuesRun &&
				clip.index === last.lastIdx + 1 &&
				delta <= MERGE_GAP_TOL_SEC &&
				delta >= -MERGE_OVERLAP_TOL_SEC &&
				(last.out - last.in) < MAX_MERGED_SOURCE_SEC
			if (range.merge !== false && adjacent) {
				last.out = Math.max(last.out, clipOut)
				last.lastIdx = clip.index
				last.count++
			} else {
				runs.push({ in: clipIn, out: clipOut, first: clip, firstIdx: clip.index, lastIdx: clip.index, count: 1 })
			}
		}

		const speed = clampSpeed(range.speed ?? 1)
		let cursor = positionFor(range)
		let capped = false
		for (let k = 0; k < runs.length; k++) {
			if (adds.length >= MAX_EXPANDED_ITEMS) {
				capped = true
				break
			}
			const run = runs[k]
			// Only an untrimmed single piece still IS that piece — a trimmed span
			// must not claim its id, or the clip UI shows the wrong thumbnail.
			const single = run.count === 1 && run.in === run.first.in && run.out === run.first.out
			const duration = (run.out - run.in) / speed
			const label = range.label
				? (runs.length === 1 ? range.label : `${range.label} ${k + 1}/${runs.length}`)
				: single
					? labelFrom(run.first)
					: run.count === 1
						? labelFrom(run.first)
						: `#${run.firstIdx}–#${run.lastIdx} (${run.count} pieces)`
			pushItem({
				id: uuidv4(),
				trackId: targetTrack.id,
				sourceAssetId: asset.id,
				// A merged run no longer maps to one detected piece — same rule the
				// razor split and the silence carve already follow. Never fake these:
				// the clip UI resolves sourceClipId to show that piece's thumbnail.
				sourceClipId: single ? run.first.id : undefined,
				masterSegmentIndex: single ? run.first.masterSegmentIndex : undefined,
				timelineStart: cursor,
				in: run.in,
				out: run.out,
				speed,
				preservePitch: true,
				duration,
				label
			})
			cursor += duration
		}
		if (capped) {
			droppedOps.push(`range #${fromIdx}–#${toIdx} of ${asset.name}: stopped at the ${MAX_EXPANDED_ITEMS}-clip limit for one edit`)
		}
	}

	if (adds.length) diff.addItems = adds
	if (adds.length > EXPANSION_ADVISORY) {
		notes.push(`This edit expands to ${adds.length} clips — fewer, larger ranges would keep the timeline easier to work with.`)
	}

	// ===== Leave no holes =====
	// Anything that frees time on a track leaves a hole unless the rest moves
	// up: removing clips, but equally retiming or trimming them. Manual editing
	// ripples for both (deleteItems, setItemSpeed); the AI path must too, or a
	// "make it shorter" edit that speeds up 200 clips leaves 200 gaps.
	const removedIds = new Set(diff.removeItemIds || [])
	const removedItems = doc.timeline.filter((i) => removedIds.has(i.id))
	const updateById = new Map((diff.updateItems || []).map((u) => [u.id, u]))

	const changes: RippleChange[] = removedItems.map((r) => ({
		trackId: r.trackId,
		at: r.timelineStart,
		delta: -itemDuration(r)
	}))
	for (const original of doc.timeline) {
		if (removedIds.has(original.id)) continue
		const update = updateById.get(original.id)
		if (!update) continue
		if (update.in == null && update.out == null && update.speed == null) continue
		const after = itemDuration({ ...original, ...update } as TimelineItem)
		const delta = after - itemDuration(original)
		if (Math.abs(delta) > 1e-9) {
			changes.push({ trackId: original.trackId, at: original.timelineStart, delta })
		}
	}

	// Items the model positioned itself stay where it put them — but ONLY those.
	// Suppressing the whole pass because of one deliberate nudge is how an edit
	// that retimes 200 clips ends up with 200 holes.
	const pinnedIds = new Set(
		(diff.updateItems || [])
			.filter((u) => typeof u.timelineStart === 'number')
			.map((u) => u.id)
	)
	const wantsCloseGaps = ops.closeGaps === true

	if (wantsCloseGaps || changes.length > 0) {
		const survivors = doc.timeline
			.filter((i) => !removedIds.has(i.id))
			.map((i) => {
				const merged = { ...i, ...(updateById.get(i.id) || {}) } as TimelineItem
				merged.duration = itemDuration(merged)
				return merged
			})
		// `adds` are the real objects, so the helpers reposition them in place.
		const working = [...survivors, ...adds]

		const moved = wantsCloseGaps
			? closeTimelineGaps({ tracks: doc.tracks, timeline: working })
			: rippleTimeline(working, changes, pinnedIds)

		if (moved) {
			const updates = diff.updateItems ? [...diff.updateItems] : []
			const byId = new Map(updates.map((u, index) => [u.id, index]))
			const originalStart = new Map(doc.timeline.map((i) => [i.id, i.timelineStart]))
			let shifted = 0
			for (const item of survivors) {
				if (Math.abs(item.timelineStart - (originalStart.get(item.id) ?? 0)) < 1e-6) continue
				shifted++
				const index = byId.get(item.id)
				if (index != null) updates[index] = { ...updates[index], timelineStart: item.timelineStart }
				else updates.push({ id: item.id, timelineStart: item.timelineStart })
			}
			if (updates.length) diff.updateItems = updates
			if (wantsCloseGaps && shifted) {
				notes.push(`Closed the gaps — ${shifted} clip${shifted === 1 ? '' : 's'} moved up.`)
			}
		}
	}

	// ===== Markers: atSec directly, atScene resolved against final placements =====
	const allPlacements: Placement[] = [
		...doc.timeline.map((i) => ({
			assetId: i.sourceAssetId,
			srcIn: i.in,
			srcOut: i.out,
			tStart: i.timelineStart,
			speed: i.speed || 1
		})),
		...placements
	]

	const resolved: { time: number; label: string }[] = []
	for (const marker of ops.addMarkers || []) {
		if (!marker?.label) continue
		if (typeof marker.atSec === 'number' && marker.atSec >= 0) {
			if (marker.atScene) notes.push(`Marker "${marker.label}" gave both atSec and atScene — used atSec.`)
			resolved.push({ time: marker.atSec, label: marker.label })
			continue
		}
		const anchor = marker.atScene
		if (!anchor) {
			droppedOps.push(`marker "${marker.label}": no position given`)
			continue
		}
		const asset = doc.media.find((a) => a.id === anchor.assetId)
		const clip = asset?.clips.find((c) => c.index === Math.round(anchor.sceneIndex))
		if (!clip) {
			droppedOps.push(`marker "${marker.label}": unknown piece #${anchor.sceneIndex} of ${asset?.name || anchor.assetId}`)
			continue
		}
		const candidates = allPlacements.filter((p) =>
			p.assetId === anchor.assetId && clip.in >= p.srcIn - 0.05 && clip.in < p.srcOut + 0.05
		)
		if (!candidates.length) {
			droppedOps.push(`marker "${marker.label}": piece #${clip.index} of ${asset!.name} is not on the timeline`)
			continue
		}
		// Same source used twice -> earliest placement, deterministically.
		const best = candidates.reduce((a, b) => (b.tStart < a.tStart ? b : a))
		// Exact: a merged run is a single linear source -> timeline mapping.
		resolved.push({
			time: Math.max(0, best.tStart + (clip.in - best.srcIn) / (best.speed || 1)),
			label: marker.label
		})
	}

	const addMarkers: { time: number; label: string }[] = []
	for (const marker of resolved.sort((a, b) => a.time - b.time)) {
		const previous = addMarkers[addMarkers.length - 1]
		if (previous && marker.time - previous.time < MARKER_DEDUPE_SEC) continue
		addMarkers.push(marker)
	}

	// ===== Transitions, looks, titles and project settings =====
	// All AFTER the adds, so they can name an item this same response created —
	// `newIds` maps the model's placement back to the id generated here.

	/** Every item the finished diff will contain, by id. */
	const finalItems = new Map<string, TimelineItem>()
	for (const item of doc.timeline) if (!removed.has(item.id)) finalItems.set(item.id, item)
	for (const item of diff.addItems ?? []) finalItems.set(item.id, item)

	/**
	 * Field patches by item id, merged into `diff.updateItems` at the end.
	 *
	 * Collected rather than pushed as we go for two reasons: several ops can
	 * touch the same clip in one response and two entries for one id would make
	 * the diff order-dependent, and an op that turns out to be invalid must not
	 * leave an empty `updateItems: []` behind for everything downstream to
	 * special-case.
	 */
	const patches = new Map<string, Partial<TimelineItem>>()
	const patchUpdate = (id: string, fields: Partial<TimelineItem>) => {
		patches.set(id, { ...patches.get(id), ...fields })
	}

	if (ops.setTransitions?.length) {
		for (const request of ops.setTransitions) {
			const item = finalItems.get(request.afterItemId)
			if (!item) {
				droppedOps.push(`transition: unknown item ${request.afterItemId}`)
				continue
			}
			if (request.kind === 'none') {
				patchUpdate(item.id, { transition: undefined })
				continue
			}
			// The catalogue is the gate: a kind this ffmpeg build cannot render
			// would fail the export rather than the request.
			if (!isTransitionKind(request.kind)) {
				droppedOps.push(`transition: unknown kind "${request.kind}"`)
				continue
			}
			const duration = Math.max(MIN_TRANSITION_SEC, Math.min(MAX_TRANSITION_SEC,
				typeof request.durationSec === 'number' && Number.isFinite(request.durationSec)
					? request.durationSec
					: DEFAULT_TRANSITION_SEC))
			patchUpdate(item.id, {
				transition: { ...item.transition, out: { kind: request.kind, duration } }
			})
		}
	}

	if (ops.clearLooks?.length) {
		for (const id of ops.clearLooks) {
			if (finalItems.has(id)) patchUpdate(id, { effects: undefined })
			else droppedOps.push(`clearLooks: unknown item ${id}`)
		}
	}

	if (ops.applyLook?.length) {
		// Accumulated per item so two looks in one response stack instead of the
		// second replacing the first.
		const pending = new Map<string, NonNullable<TimelineItem['effects']>>()
		for (const request of ops.applyLook) {
			const def = effectDef(request.kind)
			if (!def) {
				droppedOps.push(`applyLook: unknown effect "${request.kind}"`)
				continue
			}
			for (const id of request.itemIds ?? []) {
				const item = finalItems.get(id)
				if (!item) {
					droppedOps.push(`applyLook: unknown item ${id}`)
					continue
				}
				const cleared = ops.clearLooks?.includes(id)
				const base = pending.get(id) ?? (cleared ? [] : item.effects ?? [])
				pending.set(id, [
					...base,
					// Neutral defaults merged under the request, so a model that
					// names a look without parameters gets the look rather than
					// a no-op, and one that names a parameter we do not have is
					// simply ignored by the catalogue's own clamping.
					{ id: uuidv4(), kind: request.kind, params: { ...defaultParams(def), ...request.params } }
				])
			}
		}
		for (const [id, effects] of pending) patchUpdate(id, { effects })
	}

	if (ops.addTitles?.length) {
		// An ordinary video track, found by name — titles render from any lane, but
		// they get one of their own so they can sit OVER a clip rather than having
		// to fit beside it.
		let textTrack = findTitleTrack(doc.tracks)
		if (!textTrack) {
			textTrack = {
				id: uuidv4(), kind: 'video', name: TITLE_TRACK_NAME,
				order: nextTrackOrder(doc.tracks, 'video'),
				muted: false, locked: false, hidden: false, height: 40
			}
			;(diff.addTracks ||= []).push(textTrack)
		}
		const clamp01 = (n: unknown, fallback: number) =>
			typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
		for (const request of ops.addTitles) {
			const text = (request.text || '').trim()
			if (!text) {
				droppedOps.push('title: empty text')
				continue
			}
			const duration = Math.max(0.2, Math.min(60,
				typeof request.durationSec === 'number' && Number.isFinite(request.durationSec)
					? request.durationSec
					: 3))
			const start = Math.max(0, typeof request.atSec === 'number' ? request.atSec : 0)
			;(diff.addItems ||= []).push({
				id: uuidv4(), trackId: textTrack.id, sourceAssetId: '',
				timelineStart: start, in: 0, out: duration,
				speed: 1, preservePitch: true, duration,
				label: text.slice(0, 40),
				text: {
					content: text,
					x: clamp01(request.x, 0.5),
					y: clamp01(request.y, 0.85),
					size: Math.max(0.02, Math.min(0.3, typeof request.size === 'number' ? request.size : 0.07))
				}
			})
		}
	}

	if (patches.size) {
		const updates = (diff.updateItems ||= [])
		for (const [id, fields] of patches) {
			const existing = updates.find((u) => u.id === id)
			if (existing) Object.assign(existing, fields)
			else updates.push({ id, ...fields })
		}
	}

	if (ops.addBackgrounds?.length) {
		// Its own track below everything, for the same reason the UI does it:
		// on an existing track the background overlaps the footage and the
		// overlap repair discards it.
		let bgTrack = doc.tracks.find((t) => t.kind === 'video' && t.name === 'BG')
		if (!bgTrack) {
			bgTrack = {
				id: uuidv4(), kind: 'video', name: 'BG',
				order: Math.min(0, ...doc.tracks.map((t) => t.order)) - 1,
				muted: false, locked: false, hidden: false, height: 48
			}
			;(diff.addTracks ||= []).push(bgTrack)
		}
		let cursor = 0
		for (const request of ops.addBackgrounds) {
			const kind = GENERATORS.some((g) => g.kind === request.kind)
				? request.kind!
				: 'gradient'
			const duration = Math.max(0.2, Math.min(600,
				typeof request.durationSec === 'number' && Number.isFinite(request.durationSec)
					? request.durationSec
					: 5))
			// Butt-joined when unpositioned, so several in one response do not
			// land on top of each other and get repaired away.
			const start = typeof request.atSec === 'number' && request.atSec >= 0
				? request.atSec
				: cursor
			cursor = start + duration
			;(diff.addItems ||= []).push({
				id: uuidv4(), trackId: bgTrack.id, sourceAssetId: '',
				timelineStart: start, in: 0, out: duration,
				speed: 1, preservePitch: true, duration,
				label: GENERATORS.find((g) => g.kind === kind)?.label || 'Background',
				layerRole: 'background',
				generator: {
					kind,
					colour: request.colour || GENERATOR_DEFAULTS.colour,
					colour2: request.colour2 || GENERATOR_DEFAULTS.colour2,
					speed: GENERATOR_DEFAULTS.speed
				}
			})
		}
	}

	if (ops.addMotion?.length || ops.updateMotion?.length) {
		applyMotionOps(ops, doc, diff, droppedOps, notes, writer)
	}

	const docSettings: OpsToDiffResult['docSettings'] = {}
	if (typeof ops.captions === 'boolean') docSettings.captionsEnabled = ops.captions
	if (typeof ops.loudness === 'boolean') docSettings.loudnessEnabled = ops.loudness

	return { diff, addMarkers, docSettings, droppedOps, notes }
}


// ===== Motion layers =====

const MIN_MOTION_SEC = 0.2
const MAX_MOTION_SEC = 600
const MAX_MOMENT_SEC = 60

const finiteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** An op's settings, reduced to the template's own keys and typed for them. */
function motionSettingsFrom(
	raw: MotionOpSettings | undefined,
	spec: MotionSpec
): { values: Record<string, number | string>; unknown: string[] } {
	const def = resolveDefinition(spec)
	const pairs: [unknown, unknown][] = Array.isArray(raw)
		? raw.map((p) => [p?.key, p?.value])
		: Object.entries(raw ?? {})
	const values: Record<string, number | string> = {}
	const unknown: string[] = []
	for (const [key, value] of pairs) {
		const setting = def.settings.find((s) => s.key === key)
		if (!setting) { unknown.push(String(key)); continue }
		values[setting.key] = sanitiseSetting(setting, value)
	}
	return { values, unknown }
}

/**
 * New window lengths and the clip length they imply.
 *
 * Fixed windows (in, out) are stored; the flexible one (hold) never is — it is
 * whatever the clip's length leaves. So a `hold` in an op is really a request
 * for a LENGTH: in + hold + out. An explicit `durationSec` wins over it.
 */
function motionTiming(
	spec: MotionSpec,
	moments: Record<string, number> | undefined,
	durationSec: number | undefined,
	currentDuration: number
): { moments: Record<string, number>; duration: number } {
	const def = resolveDefinition(spec)
	const fixed: Record<string, number> = { ...(spec.moments ?? {}) }
	let flexAsked: number | undefined
	for (const m of def.moments) {
		const asked = moments?.[m.name]
		if (!finiteNumber(asked) || asked < 0) continue
		if (m.flex) flexAsked = Math.min(asked, MAX_MOTION_SEC)
		else fixed[m.name] = Math.min(asked, MAX_MOMENT_SEC)
	}
	let duration = currentDuration
	if (finiteNumber(durationSec)) {
		duration = durationSec
	} else if (flexAsked !== undefined) {
		duration = flexAsked + def.moments
			.filter((m) => !m.flex)
			.reduce((sum, m) => sum + (fixed[m.name] ?? m.duration), 0)
	}
	return {
		moments: fixed,
		duration: Math.max(MIN_MOTION_SEC, Math.min(MAX_MOTION_SEC, duration))
	}
}

/** The spec with empty maps dropped, so an untouched setting compares equal. */
function tidyMotion(spec: MotionSpec): MotionSpec {
	const out: MotionSpec = { ...spec }
	if (!out.settings || !Object.keys(out.settings).length) delete out.settings
	if (!out.moments || !Object.keys(out.moments).length) delete out.moments
	return out
}

/**
 * Does this request write a custom page? Agents over MCP need the user's
 * "Write custom HTML motion layers" permission for that; picking a template and
 * setting its fields is ordinary editing.
 */
export function opsWriteHtml(ops: Pick<EditorOps, 'addMotion' | 'updateMotion'>): boolean {
	const writes = (r: { html?: string } | undefined) => typeof r?.html === 'string' && r.html.trim() !== ''
	return !!ops.addMotion?.some(writes) || !!ops.updateMotion?.some(writes)
}

/**
 * Tell whoever wrote a page what is wrong with it, in the result they read: a
 * page that fails is kept as the working text but not drawn, and an agent that
 * is not told would assume it worked.
 */
function reportPageProblems(label: string, html: string, spec: MotionSpec, notes: string[]): void {
	const lint = lintMotionHtml(html)
	if (lint.ok) return
	const first = lint.issues[0]
	const more = lint.issues.length > 1 ? ` (+${lint.issues.length - 1} more)` : ''
	const shown = spec.passed
		? 'the last version that passed stays on screen'
		: 'nothing is drawn until a version passes'
	notes.push(`"${label}": line ${first.line} fails its checks — ${first.message}${more} FrameFlow keeps your page as the working text but ${shown}. Fix it with updateMotion.html.`)
}

/**
 * `addMotion` / `updateMotion` → the diff.
 *
 * A motion layer lands on a motion track (`M1`, made on top of the video
 * family when absent). Timing is the whole point of a lower third, so a clash
 * on M1 is never resolved by sliding the new layer later: it goes on the next
 * motion track that is free at that moment, made when none is.
 */
function applyMotionOps(
	ops: EditorOps,
	doc: EditorDocument,
	diff: TimelineDiff,
	droppedOps: string[],
	notes: string[],
	writer: { by: string; turnId?: string }
): void {
	const removed = new Set(diff.removeItemIds ?? [])
	const tracks = [...doc.tracks, ...(diff.addTracks ?? [])]
	const placed: TimelineItem[] = [
		...doc.timeline.filter((i) => !removed.has(i.id)),
		...(diff.addItems ?? [])
	]

	const motionTrackAt = (start: number, duration: number) => {
		const free = freeMotionTrack(tracks, placed, start, duration)
		if (free) return free
		const track = {
			id: uuidv4(), kind: 'video' as const,
			name: nextMotionTrackName(tracks),
			// On top of the video family: a graphic is in front of the picture.
			order: nextTrackOrder(tracks, 'video'),
			muted: false, locked: false, hidden: false, height: 64
		}
		tracks.push(track)
		;(diff.addTracks ||= []).push(track)
		return track
	}

	for (const request of ops.addMotion ?? []) {
		const html = typeof request?.html === 'string' && request.html.trim() ? request.html : null
		const saved = userMotionTemplate(request?.template)
		const template = motionTemplate(request?.template)
		// A page written in `html` is a custom layer, whatever template it names;
		// a saved template is copied in as a custom page the project owns.
		let base: MotionSpec
		let label: string
		if (html) {
			base = writtenSpec(saved ? newMotionSpec(saved.id) : undefined, html, writer)
			label = saved?.label ?? template?.label ?? 'Custom HTML'
			reportPageProblems(label, html, base, notes)
		} else if (template) {
			base = { template: template.id }
			label = template.label
		} else if (saved) {
			base = newMotionSpec(saved.id)
			label = saved.label
		} else if (request?.template === 'custom') {
			base = newMotionSpec()
			label = 'Custom HTML'
			notes.push('A custom layer needs `html` — added a blank one. Send the page with updateMotion.')
		} else {
			droppedOps.push(`addMotion: unknown template "${request?.template}"`)
			continue
		}
		const def = resolveDefinition(base)
		const { values, unknown } = motionSettingsFrom(request.settings, base)
		if (unknown.length) notes.push(`${label} has no setting ${unknown.map((k) => `"${k}"`).join(', ')} — ignored.`)
		const timing = motionTiming(base, request.moments, request.durationSec, def.duration)
		const spec = tidyMotion({ ...base, settings: values, moments: timing.moments })
		const start = Math.max(0, finiteNumber(request.atSec) ? request.atSec : 0)
		const track = motionTrackAt(start, timing.duration)
		const item: TimelineItem = {
			id: uuidv4(), trackId: track.id, sourceAssetId: '',
			timelineStart: start, in: 0, out: timing.duration,
			speed: 1, preservePitch: true, duration: timing.duration,
			label: request.label?.trim() || label,
			layerRole: 'overlay',
			motion: spec
		}
		placed.push(item)
		;(diff.addItems ||= []).push(item)
	}

	for (const request of ops.updateMotion ?? []) {
		const item = doc.timeline.find((i) => i.id === request?.id)
		if (!item || removed.has(item.id)) {
			droppedOps.push(`updateMotion: unknown item ${request?.id}`)
			continue
		}
		if (!item.motion) {
			droppedOps.push(`updateMotion: ${item.id} is not a motion layer`)
			continue
		}
		// A new page replaces the old one first, so the settings and windows in the
		// same request are read against the page they were written for.
		const html = typeof request.html === 'string' && request.html.trim() ? request.html : null
		const current: MotionSpec = html ? writtenSpec(item.motion, html, writer) : item.motion
		if (html) reportPageProblems(item.label || item.id, html, current, notes)
		const { values, unknown } = motionSettingsFrom(request.settings, current)
		if (unknown.length) {
			notes.push(`"${item.label || item.id}" has no setting ${unknown.map((k) => `"${k}"`).join(', ')} — ignored.`)
		}
		const timing = motionTiming(current, request.moments, request.durationSec, item.duration)
		const spec = tidyMotion({
			...current,
			settings: { ...(current.settings ?? {}), ...values },
			moments: timing.moments
		})
		const fields: Partial<TimelineItem> = { motion: spec }
		if (Math.abs(timing.duration - item.duration) > 1e-6 || item.in !== 0) {
			Object.assign(fields, { in: 0, out: timing.duration, duration: timing.duration })
		}
		if (finiteNumber(request.atSec)) fields.timelineStart = Math.max(0, request.atSec)
		const updates = (diff.updateItems ||= [])
		const existing = updates.find((u) => u.id === item.id)
		if (existing) Object.assign(existing, fields)
		else updates.push({ id: item.id, ...fields })
	}
}

// ===== Post-hoc length check =====

/** Below this fraction of the SOURCE, a build-from-scratch turn looks unintentional. */
const BUILD_SHORTFALL_RATIO = 0.7
/** Short sources are legitimately cut hard; only flag long ones on the source heuristic. */
const BUILD_MIN_SOURCE_SEC = 600
/** Below this fraction of the model's OWN stated target, it missed what it aimed for. */
const TARGET_SHORTFALL_RATIO = 0.75

/**
 * How long the result actually came out, so a 5-minute "best of" from 92 minutes
 * of source is visible instead of silent.
 *
 * Runs for every turn with a diff — the old version only fired for longform
 * build-from-scratch turns, which is meaningless now that there is no mode.
 * When the model stated a `targetSec` we judge it against that, which is the
 * only way to tell a deliberate short cut from an accidental one. Without a
 * target we fall back to the old source-ratio heuristic.
 *
 * Sums item durations rather than using computeContentEnd: a stray atSec would
 * otherwise make a short cut look hours long.
 */
export function measureBuild(
	diff: PromptTurn['diff'],
	doc: EditorDocument,
	stats: PromptStats,
	targetSec?: number
): PromptTurn['build'] {
	if (!diff || stats.sourceDurationSec <= 0) return undefined
	// opsToDiff always returns a diff OBJECT ({schemaVersion}), so truthiness is
	// not the test: an answer-only turn carries no operations, and measuring it
	// would report producedSec 0 + shortfall true — an empty warning banner on a
	// turn that proposed nothing.
	if (!diff.addItems?.length && !diff.updateItems?.length && !diff.removeItemIds?.length) {
		return undefined
	}

	const probe = {
		tracks: JSON.parse(JSON.stringify(doc.tracks)),
		timeline: JSON.parse(JSON.stringify(doc.timeline))
	}
	// Errors are ignored on purpose: this is a length estimate, and the renderer
	// runs the authoritative validation against its own live doc.
	applyTimelineDiff(probe, diff, doc.media)
	const producedSec = probe.timeline.reduce((sum: number, item: any) => sum + itemDuration(item), 0)

	const shortfall = targetSec != null && targetSec > 0
		? producedSec < TARGET_SHORTFALL_RATIO * targetSec
		: stats.timelineItemCount === 0
			&& stats.sourceDurationSec >= BUILD_MIN_SOURCE_SEC
			&& producedSec < BUILD_SHORTFALL_RATIO * stats.sourceDurationSec

	return { producedSec, sourceSec: stats.sourceDurationSec, targetSec, shortfall }
}
