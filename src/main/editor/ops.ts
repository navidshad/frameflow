import { v4 as uuidv4 } from 'uuid'
import { applyFollowers, applySoundOps } from './soundOps'
import type {
	Clip, EditorDocument, EditorOps, MediaAsset, TimelineDiff, TimelineItem
} from '@shared/types'
import {
	applyTimelineDiff, clampSpeed, closeTimelineGaps, computeContentEnd, itemDuration, itemEnd, MIN_ITEM_DURATION,
	rippleTimeline, TIMELINE_DIFF_SCHEMA_VERSION, type RippleChange
} from '@shared/timeline'
import { clampPan } from '@shared/framing'
import { planRangeRemoval } from '@shared/rangeEdit'
import { KEY_DEFAULTS } from '@shared/keying'
import { GENERATOR_DEFAULTS, GENERATORS } from '@shared/generators'
import { hasTransform, OFFSET_RANGE, SCALE_RANGE } from '@shared/transform'
import { defaultParams, effectDef } from '@shared/effects'
import { findTitleTrack, nextTrackOrder, TITLE_TRACK_NAME } from '@shared/tracks'
import {
	freeMotionTrack, isMotionTrack, lengthAfterPageChange, lintMotionHtml, motionTemplate, newMotionSpec, nextMotionTrackName, resolveDefinition,
	sanitiseSetting, type MotionDefinition, type MotionSpec
} from '@shared/motion'
import { extractMotionDefinition, keyframingNote, writtenSpec } from '@shared/motionCode'
import { MOTION_CRAFT_LINES } from '@shared/motionGuide'
import { userMotionTemplate } from '@shared/motionTemplates'
import { applyMotionKitOps, withKit } from './kitOps'
import { applyMulticamOps, opsTouchMulticam } from './multicamOps'
import { groupRippleCut } from '@shared/multicam'
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
		'Helpers: frameflow.progress("in", t), ease(x), clamp(x, lo, hi). A page that breaks the rules ' +
		'(clocks, timers, random, CSS animation, network, or drawing differently on a second visit to the same t) ' +
		'is not applied: the layer keeps its earlier page and the result says why.'
}

const MOTION_KIT_SCHEMA = {
	type: 'string',
	description: 'Custom pages only: the id of a project motion kit whose shared CSS and JS the page builds on. "" stops using one.'
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
					kit: MOTION_KIT_SCHEMA,
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
					kit: MOTION_KIT_SCHEMA,
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
	docSettings: { captionsEnabled?: boolean; loudnessEnabled?: boolean; frame?: { width: number; height: number } }
	droppedOps: string[]
	notes: string[]
}

const labelFrom = (clip: Clip): string =>
	(clip.visual || clip.text)?.replace(/\s+/g, ' ').trim().slice(0, 40) || `Piece #${clip.index}`

/** Sorted, with overlapping or touching spans joined, so no time is ripple-counted twice. */
function mergeSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
	const sorted = spans.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
	const out: { start: number; end: number }[] = []
	for (const span of sorted) {
		const last = out[out.length - 1]
		if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
		else out.push({ ...span })
	}
	return out
}

export function opsToDiff(
	ops: EditorOps,
	doc: EditorDocument,
	/** Who is writing, for the "Written by …" line on a custom page. */
	writer: { by: string; turnId?: string } = { by: 'FrameFlow AI' },
	/** Sounds the caller already rendered, by recipe key (see soundOps.soundRecipesOf). */
	soundAssets: Map<string, MediaAsset> = new Map(),
	/**
	 * What each page reported to `define` when the probe ran it, by its html
	 * (vetHtmlOps' `definitions`). Ahead of the text read, which cannot see
	 * `duration: SPEC.duration`.
	 */
	pageDefinitions: Map<string, MotionDefinition> = new Map()
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
	// ===== Splits: a cut that removes nothing =====
	// Each half plays exactly what the whole did, so nothing ripples: the
	// shaped originals are kept out of the ripple pass below like a range's.
	const splitShapedIds = new Set<string>()
	if (ops.splitAt?.length) {
		const updates = new Map<string, TimelineItem>()
		const pieces: TimelineItem[] = []
		const splittable = (i: TimelineItem) => !i.motion && !i.text && !i.generator
		const current = () => [
			...doc.timeline.filter((i) => !diff.removeItemIds?.includes(i.id)).map((i) => updates.get(i.id) ?? i),
			...pieces
		]
		for (const split of [...ops.splitAt].sort((a, b) => a.atSec - b.atSec)) {
			const at = Number(split.atSec)
			const hits = current().filter((i) =>
				(split.trackId ? i.trackId === split.trackId : splittable(i)) &&
				at > i.timelineStart + MIN_ITEM_DURATION && at < i.timelineStart + itemDuration(i) - MIN_ITEM_DURATION)
			if (!hits.length) {
				droppedOps.push(`splitAt ${at}: no clip runs across that time (or it is within ${MIN_ITEM_DURATION}s of an edge)`)
				continue
			}
			for (const item of hits) {
				const speed = item.speed || 1
				const cutSource = item.in + (at - item.timelineStart) * speed
				// A fade belongs to the end it was on: the left half keeps the fade-in, the right the fade-out.
				const left: TimelineItem = {
					...item, out: cutSource, duration: at - item.timelineStart, transition: undefined,
					...(item.fadeOutSec ? { fadeOutSec: 0 } : {})
				}
				const right: TimelineItem = {
					...JSON.parse(JSON.stringify(item)), id: uuidv4(), timelineStart: at, in: cutSource,
					duration: item.timelineStart + itemDuration(item) - at,
					...(item.fadeInSec ? { fadeInSec: 0 } : {})
				}
				if (item.keyframes && Object.keys(item.keyframes).length) {
					notes.push(`${item.label || item.id} has keyframes; they stay on the first half after the split.`)
					delete (right as Partial<TimelineItem>).keyframes
				}
				const pieceIndex = pieces.findIndex((p) => p.id === item.id)
				if (pieceIndex >= 0) pieces[pieceIndex] = left
				else updates.set(item.id, left)
				pieces.push(right)
			}
		}
		for (const [id, left] of updates) {
			splitShapedIds.add(id)
			const list = (diff.updateItems ||= [])
			const fields = {
				out: left.out, duration: left.duration, transition: undefined, masterSegmentIndex: undefined,
				...(left.fadeOutSec === 0 ? { fadeOutSec: 0 } : {})
			}
			const existing = list.find((u) => u.id === id)
			if (existing) Object.assign(existing, fields)
			else list.push({ id, ...fields })
		}
		if (pieces.length) {
			diff.addItems = [...(diff.addItems || []), ...pieces]
			notes.push(`Split ${updates.size} clip(s) into ${updates.size + pieces.length} pieces. get_timeline shows the new ids.`)
		}
	}

	// What the range cuts free, for the ripple below: a range takes its time out
	// of EVERY track (it cut every track's items in the span), so every track
	// closes up by the same amount and layers stay in sync with the picture.
	const rangeChanges: RippleChange[] = []
	const rangeShapedIds = new Set<string>()
	const rangeRemovedIds = new Set<string>()
	let rangeAdded: TimelineItem[] = []
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
			for (const id of plan.removeIds) rangeRemovedIds.add(id)
			for (const shaped of plan.updated) rangeShapedIds.add(shaped.id)
			rangeAdded = plan.added
			for (const span of mergeSpans(ops.removeRanges.map((r) => ({ start: r.fromSec, end: r.toSec })))) {
				for (const track of doc.tracks) rangeChanges.push({ trackId: track.id, at: span.start, delta: -(span.end - span.start) })
			}
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

	// Appended: a range removal in the same edit already put its split halves here.
	if (adds.length) diff.addItems = [...(diff.addItems || []), ...adds]
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
	// A camera group's shot takes its stretch out of the group's sound too
	// (shared with the editor's delete), or later shots lose sync. The cut's
	// own time is counted by its changes, like a range's.
	const groupCut = groupRippleCut(doc.timeline, removedItems.filter((r) => !rangeRemovedIds.has(r.id)), uuidv4)
	if (groupCut.removeIds.length || groupCut.updated.length || groupCut.added.length) {
		diff.removeItemIds = [...(diff.removeItemIds ?? []), ...groupCut.removeIds]
		for (const id of groupCut.removeIds) { removedIds.add(id); rangeRemovedIds.add(id) }
		const list = (diff.updateItems ||= [])
		for (const u of groupCut.updated) {
			rangeShapedIds.add(u.id)
			const fields = { in: u.in, out: u.out, duration: u.duration, timelineStart: u.timelineStart }
			const existing = list.find((x) => x.id === u.id)
			if (existing) Object.assign(existing, fields)
			else list.push({ id: u.id, ...fields })
		}
		diff.addItems = [...(diff.addItems ?? []), ...groupCut.added]
		rangeAdded = [...rangeAdded, ...groupCut.added]
		rangeChanges.push(...groupCut.changes)
		notes.push('A removed camera-group shot took the same stretch out of the group\'s sound, so the shots after it stay in sync.')
	}
	const updateById = new Map((diff.updateItems || []).map((u) => [u.id, u]))

	// A range's own removals and trims are counted once, by the range itself.
	const changes: RippleChange[] = [
		...removedItems.filter((r) => !rangeRemovedIds.has(r.id)).map((r) => ({
			trackId: r.trackId,
			at: r.timelineStart,
			delta: -itemDuration(r)
		})),
		...rangeChanges
	]
	for (const original of doc.timeline) {
		if (removedIds.has(original.id) || rangeShapedIds.has(original.id) || splitShapedIds.has(original.id)) continue
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
			.filter((u) => typeof u.timelineStart === 'number' && !rangeShapedIds.has(u.id) && !splitShapedIds.has(u.id))
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
		// `adds` and a range's split halves are the real objects, so the helpers reposition them in place.
		const working = [...survivors, ...adds, ...rangeAdded]
		// Where each survivor sat BEFORE the ripple, this edit's own updates applied. A clip a range
		// trimmed from its start already has a new start in the diff; comparing the rippled start
		// with its original one would drop the ripple when the two happen to match (a cut that
		// begins exactly where the clip begins) and leave the trimmed start in place.
		const preRipple = new Map(survivors.map((i) => [i.id, i.timelineStart]))

		const moved = wantsCloseGaps
			? closeTimelineGaps({ tracks: doc.tracks, timeline: working })
			: rippleTimeline(working, changes, pinnedIds)

		if (moved) {
			const updates = diff.updateItems ? [...diff.updateItems] : []
			const byId = new Map(updates.map((u, index) => [u.id, index]))
			let shifted = 0
			for (const item of survivors) {
				if (Math.abs(item.timelineStart - (preRipple.get(item.id) ?? 0)) < 1e-6) continue
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

	// Kits before layers: a layer added in this call may name a kit set in it.
	const motionOps = ops.setMotionKits?.length || ops.removeMotionKits?.length || ops.addMotion?.some((r) => r?.kit) || ops.updateMotion?.some((r) => r?.kit !== undefined)
		? applyMotionKitOps(ops, doc, diff, droppedOps, notes)
		: ops
	if (motionOps.addMotion?.length || motionOps.updateMotion?.length) {
		applyMotionOps(motionOps, doc, diff, droppedOps, notes, writer, pageDefinitions)
	}

	if (opsTouchMulticam(ops)) applyMulticamOps(ops, doc, diff, droppedOps, notes)

	if (ops.addSounds?.length || ops.setSounds?.length || ops.setTrackRoles?.length || ops.placeAudio?.length) {
		applySoundOps(ops, doc, diff, droppedOps, notes, soundAssets)
	}
	// Sounds that follow a moment go with it, in this same diff.
	applyFollowers(doc, diff, [...soundAssets.values()])

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
	if (lint.ok) {
		const note = keyframingNote(label, spec.passed?.definition ?? spec.definition)
		if (note) notes.push(note)
		return
	}
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
	writer: { by: string; turnId?: string },
	pageDefinitions: Map<string, MotionDefinition>
): void {
	const removed = new Set(diff.removeItemIds ?? [])
	const tracks = [...doc.tracks, ...(diff.addTracks ?? [])]
	const placed: TimelineItem[] = [
		...doc.timeline.filter((i) => !removed.has(i.id)),
		...(diff.addItems ?? [])
	]

	const motionTrackAt = (start: number, duration: number, ignoreId?: string) => {
		const free = freeMotionTrack(tracks, placed, start, duration, ignoreId)
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
			base = writtenSpec(saved ? newMotionSpec(saved.id) : undefined, html, writer, pageDefinitions.get(html))
			label = saved?.label ?? template?.label ?? 'Custom HTML'
			// By the name the writer gave it, which is the one it will recognise.
			reportPageProblems(request.label?.trim() || label, html, base, notes)
			reportUnreadDefinition(request.label?.trim() || label, html, pageDefinitions.get(html), notes, finiteNumber(request.durationSec))
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
		const spec = tidyMotion(withKit({ ...base, settings: values, moments: timing.moments }, request.kit))
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
		const name = item.label || item.id
		const runtime = html ? pageDefinitions.get(html) : undefined
		const current: MotionSpec = html ? writtenSpec(item.motion, html, writer, runtime) : item.motion
		if (html) {
			reportPageProblems(name, html, current, notes)
			reportUnreadDefinition(name, html, runtime, notes, finiteNumber(request.durationSec))
		}
		const { values, unknown } = motionSettingsFrom(request.settings, current)
		if (unknown.length) {
			notes.push(`"${name}" has no setting ${unknown.map((k) => `"${k}"`).join(', ')} — ignored.`)
		}
		// A layer at its page's own length follows a page that runs longer or
		// shorter — but only a length FrameFlow actually knows. A definition it
		// could not read (`duration: SPEC.duration`, never run) is not a reason
		// to cut a 9 s card to the 3 s default.
		const readable = !html || !!runtime || extractMotionDefinition(html).complete
		const follows = readable ? lengthAfterPageChange(item.motion, current, item.duration) : item.duration
		const timing = motionTiming(current, request.moments, request.durationSec, follows)
		const spec = tidyMotion(withKit({
			...current,
			settings: { ...(current.settings ?? {}), ...values },
			moments: timing.moments
		}, request.kit))
		const fields: Partial<TimelineItem> = { motion: spec }
		const resized = Math.abs(timing.duration - item.duration) > 1e-6
		if (resized || item.in !== 0) {
			Object.assign(fields, { in: 0, out: timing.duration, duration: timing.duration })
		}
		// Say so whenever the page, not the request, changed the length.
		if (html && resized && Math.abs(follows - item.duration) > 1e-6 && Math.abs(timing.duration - follows) < 1e-6) {
			notes.push(`"${name}" was at its page's length, so it follows the new page: ${secs(item.duration)} → ${secs(timing.duration)}. Send durationSec to keep a different length.`)
		}
		const start = finiteNumber(request.atSec) ? Math.max(0, request.atSec) : item.timelineStart
		if (finiteNumber(request.atSec)) fields.timelineStart = start

		// A retime that runs into another layer on its track moves THIS layer to a
		// free motion track, as addMotion does. Nothing else on the track moves.
		const moved = finiteNumber(request.atSec) || resized
		// A copy: `placed` holds the document's own items, which must not change here.
		const at = placed.findIndex((p) => p.id === item.id)
		const here = at >= 0 ? { ...placed[at], timelineStart: start, in: 0, out: timing.duration, duration: timing.duration, speed: 1 } : undefined
		if (here) placed[at] = here
		if (moved) {
			const track = tracks.find((t) => t.id === item.trackId)
			const stays = track && isMotionTrack(track) && !track.locked
				? freeMotionTrack([track], placed, start, timing.duration, item.id)
				: null
			if (track && !stays) {
				const clash = placed.find((p) =>
					p.id !== item.id && p.trackId === item.trackId &&
					p.timelineStart < start + timing.duration - 1e-6 && itemEnd(p) > start + 1e-6)
				const to = motionTrackAt(start, timing.duration, item.id)
				fields.trackId = to.id
				if (here) here.trackId = to.id
				const why = clash ? ` it would overlap "${clash.label || clash.id}" on ${track.name}` : ` ${track.name} is not free then`
				notes.push(`"${name}" moved to ${to.name}:${why} at ${secs(start)}–${secs(start + timing.duration)}. Nothing else moved.`)
			}
		}
		const updates = (diff.updateItems ||= [])
		const existing = updates.find((u) => u.id === item.id)
		if (existing) Object.assign(existing, fields)
		else updates.push({ id: item.id, ...fields })
	}
}

/** "9.5 s" — three significant decimals at most. */
const secs = (n: number) => `${Math.round(n * 1000) / 1000} s`

/**
 * A page whose `define` uses expressions (`duration: SPEC.duration`) cannot be
 * read from its text. Say what that means for this layer: read by running it,
 * or not known at all (and so the length is left alone).
 */
function reportUnreadDefinition(
	label: string,
	html: string,
	runtime: MotionDefinition | undefined,
	notes: string[],
	explicitLength: boolean
): void {
	const read = extractMotionDefinition(html)
	if (!read.found || read.complete) return
	const parts = read.problems.filter((p) => /not a literal/.test(p)).map((p) => p.split(' ')[0])
	const what = parts.length ? parts.join(', ') : 'part of it'
	const head = `"${label}": frameflow.define() uses expressions FrameFlow cannot read from the text (${what}).`
	if (runtime) {
		notes.push(`${head} It read them by running the page: ${secs(runtime.duration)}, ${runtime.moments.length} moments. Literal numbers in define() keep this exact without a run.`)
	} else {
		const length = explicitLength ? '' : ' so the layer keeps the length it had (or 3 s, for a new one) — send durationSec, or'
		notes.push(`${head} The page has not been run here,${length} write literal numbers in define().`)
	}
}
