import { randomUUID } from 'node:crypto'
import type { EditorOps, MediaAsset, PromptTurn, TimelineItem } from '@shared/types'
import { motionWorkingHtml, resolveDefinition, resolveMoments, type MotionSpec } from '@shared/motion'
import { motionStatus } from '@shared/motionCode'
import { opKeys, opsInputSchema, validateArgs, type AgentPermission, type AgentPermissions, type JsonSchema } from '@shared/agent'
import {
	clock, countWords, opChips, pageRows, searchMoments, summarizeMedia, summarizeSearch, summarizeTimeline,
	transcriptHealthLabel, type AgentChip, type SearchSource
} from '@shared/agentFeed'
import { allEffects } from '@shared/effects'
import { TRANSITION_PRESETS } from '@shared/transitionPresets'
import { computeContentEnd } from '@shared/timeline'
import { EDITOR_OPS_SCHEMA, opsToDiff, opsWriteHtml } from '../editor/ops'
import { vetHtmlOps, type MotionProbe } from '../editor/vetHtml'
import { MOTION_TEMPLATES, userMotionTemplates } from '@shared/motionTemplates'
import { motionGuideText } from '@shared/motionGuide'
import { soundGuideText } from '@shared/soundGuide'
import { estimateMix } from '@shared/mix'
import { cueLead, describeCue, suggestCues } from '@shared/sound'
import {
	isSoundKind, normaliseRecipe, presetOf, recipeKey, SOUND_PRESETS, soundLength, soundPeakDb, type SoundRecipe
} from '@shared/synth'
import { opsMakeSound, soundRecipesOf } from '../editor/soundOps'
import {
	CAPABILITY_LABEL, formatCost, isCapability, isProviderId, LIMITS, PROVIDERS, providerInfo, requestProblem, spendDecision,
	type AudioCapability, type GenerateRequest, type Spent
} from '@shared/audioProviders'
import type { EditorBridge, LiveProject } from './bridge'

/**
 * FrameFlow's MCP tools. Each one says what it is FOR in its description,
 * because that is all an agent has to choose by.
 *
 * No Electron here: everything that touches the app goes through the bridge,
 * so the integration test can drive these with a fake one.
 */

export interface ToolContext {
	sessionId: string
	clientName: string
	bridge: EditorBridge
	permissions: () => AgentPermissions
	/** FrameFlow's own CLI engine: the chat turn these edits belong to. */
	engineTurnId?: string
	/** Draws a page in the hidden window. Absent where there is none (tests): the lint decides alone. */
	probeMotion?: MotionProbe
	/** What this turn has already spent generating audio; generate_audio adds to it. */
	spent?: Spent
}

/** What the activity feed shows for one call. */
export interface FeedEntry {
	title?: string
	detail?: string
	quote?: string
	chips?: AgentChip[]
	thumbnail?: string
}

export type ToolContent =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }

export interface ToolOutcome {
	content: ToolContent[]
	isError?: boolean
	feed: FeedEntry
}

export interface ToolDef {
	name: string
	description: string
	inputSchema: JsonSchema
	permission: AgentPermission
	/**
	 * A second permission this particular call needs, decided from its arguments:
	 * `apply_ops` is "edit", but one that writes a custom HTML page is also "html".
	 */
	alsoNeeds?: (args: Record<string, any>) => AgentPermission | null
	/** Writes are serialised, so each one sees the result of the last. */
	writes?: boolean
	/** The feed title before the call finishes ("render_frame 0:27.5"). */
	title?: (args: Record<string, any>) => string
	run(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome>
}

// ===== Helpers =====

export class ToolError extends Error {}

const NO_PROJECT =
	'No project is open in FrameFlow’s editor. Ask the user to open the project they want edited ' +
	'(Home → the project), then try again.'

async function requireProject(ctx: ToolContext): Promise<LiveProject> {
	const project = await ctx.bridge.getLiveProject()
	if (!project) throw new ToolError(NO_PROJECT)
	return project
}

/** Three decimals is a millisecond: enough for any edit, and it keeps replies short. */
const r3 = (n: number | undefined): number | undefined =>
	typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n

const json = (value: unknown): ToolContent => ({ type: 'text', text: JSON.stringify(value) })

/** Accepts an id, or a file name with or without its extension — agents quote what they saw. */
export function resolveAsset(media: MediaAsset[], ref: string): MediaAsset {
	const wanted = String(ref || '').trim()
	const lower = wanted.toLowerCase()
	const stem = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, '')
	const found = media.find((a) => a.id === wanted) ||
		media.find((a) => a.name.toLowerCase() === lower) ||
		media.find((a) => stem(a.name) === stem(wanted))
	if (!found) {
		throw new ToolError(`No media "${wanted}". Media in this project: ${media.map((a) => `${a.name} (${a.id})`).join(', ') || 'none'}.`)
	}
	return found
}

const versionLabel = (project: LiveProject, revisionId: string | null | undefined) => {
	const rev = project.revisions.find((r) => r.id === revisionId)
	return rev ? `V${rev.seq}` : null
}

/**
 * A motion layer without its page source: what it is, how it is timed and set,
 * how big its page is and whether it passed its checks. A custom page is often
 * 100 KB or more and is stored twice (working and last passed), so the source
 * comes only when asked for (`include: ['html']`).
 */
export function motionSummary(spec: MotionSpec, clipDuration: number) {
	const windows = (() => {
		try {
			return resolveMoments(spec, clipDuration, resolveDefinition(spec)).map((m) => ({ name: m.name, sec: r3(m.duration) }))
		} catch {
			return undefined
		}
	})()
	if (spec.template) {
		return { kind: 'template' as const, template: spec.template, settings: spec.settings, moments: spec.moments, windows }
	}
	const def = resolveDefinition(spec)
	const working = motionWorkingHtml(spec)
	const status = motionStatus(spec)
	return {
		kind: 'custom' as const,
		settings: spec.settings,
		moments: spec.moments,
		windows,
		definition: {
			durationSec: r3(def.duration),
			settings: def.settings.map((s) => s.key),
			moments: def.moments.map((m) => m.name)
		},
		page: {
			chars: working.length,
			passedChars: spec.passed ? spec.passed.html.length : null,
			// ok: the working page is the one drawn; last-passing: it fails, an older one is drawn; nothing: none has passed.
			state: status.state,
			passed: !!spec.passed,
			verified: !!spec.passed?.verified,
			workingIsPassed: !!spec.passed && spec.passed.html === working
		},
		author: spec.author?.by
	}
}

function describeItem(
	item: TimelineItem,
	names: Map<string, string>,
	recipes?: Map<string, MediaAsset['synth']>,
	options: { html?: boolean } = {}
) {
	const { masterSegmentIndex, sourceClipId, preservePitch, bind, motion, ...rest } = item
	const sound = recipes?.get(item.sourceAssetId)
	return {
		...rest,
		motion: motion ? (options.html ? motion : motionSummary(motion, item.duration)) : undefined,
		asset: item.sourceAssetId ? names.get(item.sourceAssetId) : undefined,
		// A synthesised sound: its recipe, and the moment it follows (pass these to setSounds).
		sound: sound ? { kind: sound.kind, variant: sound.variant, pitch: sound.pitch, levelDb: sound.levelDb, air: sound.air, seed: sound.seed, durationSec: sound.durationSec || undefined } : undefined,
		follows: bind ? { item: bind.itemId, at: bind.at, leadSec: r3(bind.leadSec) } : undefined,
		timelineStart: r3(item.timelineStart),
		endSec: r3(item.timelineStart + item.duration),
		in: r3(item.in),
		out: r3(item.out),
		duration: r3(item.duration)
	}
}

// ===== Tools =====

const getProject: ToolDef = {
	name: 'get_project',
	permission: 'read',
	description:
		'Start here. Describes the project open in FrameFlow right now: title, frame size and fps, ' +
		'duration, tracks, every media file (id, name, kind, length, whether it has a transcript and ' +
		'scene descriptions), markers, the revision list (V numbers) and which one is current, what you ' +
		'are allowed to do, and the catalogues of transition kinds and effect kinds that apply_ops ' +
		'accepts. The ids it returns are what the other tools take.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run(_args, ctx) {
		const project = await requireProject(ctx)
		const { doc } = project
		const perms = ctx.permissions()
		const current = versionLabel(project, project.currentRevisionId)
		const body = {
			project: { id: project.threadId, title: project.title },
			frame: {
				width: doc.timelineMeta.width, height: doc.timelineMeta.height,
				fps: doc.timelineMeta.fps, aspectRatio: doc.timelineMeta.aspectRatio
			},
			durationSec: r3(computeContentEnd(doc.timeline)),
			playheadSec: r3(project.playheadSec),
			itemCount: doc.timeline.length,
			tracks: [...doc.tracks].sort((a, b) => a.order - b.order).map((t) => ({
				id: t.id, kind: t.kind, name: t.name, order: t.order,
				muted: t.muted, hidden: t.hidden, locked: t.locked, role: t.role
			})),
			media: doc.media.map((a) => ({
				id: a.id, name: a.name, kind: a.kind,
				durationSec: r3(a.metadata?.duration),
				width: a.metadata?.width, height: a.metadata?.height,
				processing: a.preprocessState || 'pending',
				hasTranscript: !!a.preprocessing?.transcriptPath,
				transcriptHealth: a.preprocessing?.transcriptPath ? transcriptHealthLabel(a.transcriptHealth) : undefined,
				scenes: a.clips.length,
				describedScenes: a.clips.filter((c) => c.visual).length
			})),
			markers: (doc.markers || []).map((m) => ({ atSec: r3(m.time), label: m.label })),
			captionsEnabled: !!doc.captionsEnabled,
			loudnessEnabled: !!doc.loudnessEnabled,
			revisions: {
				current,
				list: [...project.revisions].sort((a, b) => a.seq - b.seq).slice(-30).map((r) => ({
					version: r.seq, label: r.label, origin: r.origin,
					parent: versionLabel(project, r.parentId), createdAt: new Date(r.createdAt).toISOString()
				}))
			},
			permissions: {
				read: true, editTimeline: perms.edit, writeHtmlMotion: perms.html, exportVideos: perms.export, makeSounds: perms.sound
			},
			catalog: {
				// For apply_ops addMotion.template. Saved templates are the user's own
				// custom layers; they appear here the moment they are saved.
				motionTemplates: [
					...MOTION_TEMPLATES.map((t) => ({
						id: t.id, label: t.label, description: t.description, durationSec: t.definition.duration,
						settings: t.definition.settings.map((s) => s.key)
					})),
					...userMotionTemplates().map((t) => ({
						id: t.id, label: t.label, description: t.description, durationSec: t.definition.duration,
						settings: t.definition.settings.map((s) => s.key), saved: true
					}))
				],
				// For apply_ops addSounds.kind. get_sound_guide / list_sounds say more.
				sounds: SOUND_PRESETS.map((p) => p.kind),
				transitions: TRANSITION_PRESETS.map((p) => p.kind),
				effects: allEffects().map((e) => ({
					kind: e.kind, stream: e.stream, label: e.label,
					params: e.params.map((p: any) => p.key)
				}))
			}
		}
		return {
			content: [json(body)],
			feed: { detail: `${project.title} · ${doc.media.length} media · ${current || 'no revisions yet'}` }
		}
	}
}

const getTimeline: ToolDef = {
	name: 'get_timeline',
	permission: 'read',
	description:
		'The edit as it stands this moment, read live from the editor — including changes the user just ' +
		'made by hand. Every item: id, track, source media, timeline start and end, source in/out, speed, ' +
		'label, effects, transitions, titles. Timeline items are in TIMELINE seconds; in/out are SOURCE ' +
		'seconds. Motion layers come as a summary (template or custom, settings, moment windows, page size, ' +
		'whether the page passed its checks, who wrote it) without their page source: pass include ["html"] ' +
		'with itemIds to read the pages you mean to change. Never cached: read it again after the user edits. ' +
		'Paged — pass nextOffset as offset to read on.',
	inputSchema: {
		type: 'object',
		properties: {
			offset: { type: 'integer', minimum: 0, description: 'First item to return (from nextOffset)' },
			limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Items per page (default 200)' },
			trackId: { type: 'string', description: 'Only this track' },
			fromSec: { type: 'number', description: 'Only items that end after this timeline time' },
			toSec: { type: 'number', description: 'Only items that start before this timeline time' },
			itemIds: { type: 'array', items: { type: 'string' }, description: 'Only these items' },
			include: {
				type: 'array', items: { type: 'string', enum: ['html'] },
				description: 'html: each motion layer in full, with its custom page source (working and last passed). Large: narrow with itemIds'
			}
		},
		additionalProperties: false
	},
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const { doc } = project
		const html = Array.isArray(args.include) && args.include.includes('html')
		const only = Array.isArray(args.itemIds) && args.itemIds.length ? new Set<string>(args.itemIds.map(String)) : null
		const names = new Map(doc.media.map((a) => [a.id, a.name]))
		const recipes = new Map(doc.media.filter((a) => a.synth).map((a) => [a.id, a.synth]))
		const items = [...doc.timeline]
			.filter((i) => !args.trackId || i.trackId === args.trackId)
			.filter((i) => !only || only.has(i.id))
			.filter((i) => args.fromSec === undefined || i.timelineStart + i.duration > args.fromSec)
			.filter((i) => args.toSec === undefined || i.timelineStart < args.toSec)
			.sort((a, b) => a.timelineStart - b.timelineStart)
			.map((i) => describeItem(i, names, recipes, { html }))
		const page = pageRows(items, { offset: args.offset, limit: args.limit ?? 200, maxChars: 60_000 })
		const missing = only ? [...only].filter((id) => !doc.timeline.some((i) => i.id === id)) : []
		const hasCustom = !html && page.rows.some((i) => !!i.motion && 'kind' in i.motion && i.motion.kind === 'custom')
		return {
			content: [json({
				durationSec: r3(computeContentEnd(doc.timeline)),
				currentRevision: versionLabel(project, project.currentRevisionId),
				items: page.rows, offset: page.offset, total: page.total, nextOffset: page.nextOffset,
				notFound: missing.length ? missing : undefined,
				pages: hasCustom ? 'Custom page sources are left out. get_timeline {itemIds: [...], include: ["html"]} returns them.' : undefined
			})],
			feed: { detail: summarizeTimeline(doc.timeline) }
		}
	}
}

const getMedia: ToolDef = {
	name: 'get_media',
	permission: 'read',
	description:
		'Everything FrameFlow knows about one media file: its transcript (what is said, with SOURCE ' +
		'timestamps), its detected scenes (numbered pieces with source in/out, what is on screen and what ' +
		'is said), and health flags that tell you when a transcript is unreliable (looped, stops early, ' +
		'has a gap). Use scene numbers with addSceneRanges/addClips. Long media is paged under a character ' +
		'budget: narrow with fromSec/toSec, and pass nextTranscriptOffset / nextScenesOffset to read on.',
	inputSchema: {
		type: 'object',
		properties: {
			asset: { type: 'string', description: 'Media id or file name from get_project' },
			include: {
				type: 'array', items: { type: 'string', enum: ['transcript', 'scenes'] },
				description: 'Which parts (default both)'
			},
			fromSec: { type: 'number', description: 'Source seconds: skip what ends before this' },
			toSec: { type: 'number', description: 'Source seconds: skip what starts after this' },
			transcriptOffset: { type: 'integer', minimum: 0 },
			scenesOffset: { type: 'integer', minimum: 0 },
			maxChars: { type: 'integer', minimum: 2000, maximum: 100000, description: 'Reply budget (default 30000)' }
		},
		required: ['asset'],
		additionalProperties: false
	},
	title: (args) => `get_media ${String(args.asset || '').replace(/\.[^.]+$/, '')}`,
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const asset = resolveAsset(project.doc.media, args.asset)
		const include: string[] = args.include?.length ? args.include : ['transcript', 'scenes']
		const budget = (args.maxChars ?? 30_000) / include.length
		const inRange = (start: number, end: number) =>
			(args.fromSec === undefined || end > args.fromSec) && (args.toSec === undefined || start < args.toSec)

		const transcript = (await ctx.bridge.readTranscripts(project, [asset.id]))[asset.id]
		const words = transcript ? transcript.reduce((n, e) => n + countWords(e.text), 0) : null
		const body: Record<string, unknown> = {
			id: asset.id, name: asset.name, kind: asset.kind,
			durationSec: r3(asset.metadata?.duration),
			width: asset.metadata?.width, height: asset.metadata?.height,
			processing: asset.preprocessState || 'pending',
			transcriptHealth: transcript ? asset.transcriptHealth || null : undefined,
			// Why there is no transcript, when the last run failed.
			transcriptError: !transcript ? asset.transcriptError || undefined : undefined,
			descriptionHealth: asset.descriptionHealth || undefined
		}
		if (include.includes('transcript')) {
			if (!transcript) body.transcript = null
			else {
				const rows = transcript.filter((e) => inRange(e.start, e.end))
					.map((e) => ({ start: r3(e.start), end: r3(e.end), text: e.text }))
				const page = pageRows(rows, { offset: args.transcriptOffset, maxChars: budget })
				body.transcript = page.rows
				body.transcriptTotal = page.total
				body.nextTranscriptOffset = page.nextOffset
			}
		}
		if (include.includes('scenes')) {
			const rows = asset.clips.filter((c) => inRange(c.in, c.out)).map((c) => ({
				scene: c.index, in: r3(c.in), out: r3(c.out), seen: c.visual || undefined, said: c.text || undefined
			}))
			const page = pageRows(rows, { offset: args.scenesOffset, maxChars: budget })
			body.scenes = page.rows
			body.scenesTotal = page.total
			body.nextScenesOffset = page.nextOffset
		}
		return {
			content: [json(body)],
			feed: {
				title: `get_media ${asset.name.replace(/\.[^.]+$/, '')}`,
				detail: summarizeMedia({
					words, scenes: asset.clips.length,
					transcriptHealth: asset.transcriptHealth, descriptionHealth: asset.descriptionHealth
				})
			}
		}
	}
}

const searchMomentsTool: ToolDef = {
	name: 'search_moments',
	permission: 'read',
	description:
		'Find where something is said or shown, across every media file’s transcript and scene ' +
		'descriptions. Returns the best matches with media id, SOURCE time, the matching line, and the ' +
		'TIMELINE time(s) where that moment currently plays (empty when it is not on the timeline). Plain ' +
		'word matching — if nothing comes back, try other words. Use it to find a quote before cutting ' +
		'around it or placing something on it.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Words that are spoken, or that describe what is on screen' },
			asset: { type: 'string', description: 'Only this media (id or file name)' },
			limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most hits to return (default 10)' }
		},
		required: ['query'],
		additionalProperties: false
	},
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const media = args.asset ? [resolveAsset(project.doc.media, args.asset)] : project.doc.media
		const transcripts = await ctx.bridge.readTranscripts(project, media.map((a) => a.id))
		const sources: SearchSource[] = media.map((a) => ({
			assetId: a.id, assetName: a.name,
			transcript: transcripts[a.id] || [],
			scenes: a.clips.map((c) => ({ index: c.index, in: c.in, out: c.out, visual: c.visual }))
		}))
		const query = String(args.query)
		const hits = searchMoments(query, sources, project.doc.timeline, args.limit ?? 10)
		return {
			content: [json({
				query,
				hits: hits.map((h) => ({
					asset: h.assetId, assetName: h.assetName, kind: h.kind, scene: h.sceneIndex,
					sourceStart: r3(h.sourceStart), sourceEnd: r3(h.sourceEnd),
					timelineSec: h.timelineSec.map((t) => r3(t)), text: h.text
				}))
			})],
			feed: { detail: summarizeSearch(query, hits) }
		}
	}
}

const renderFrame: ToolDef = {
	name: 'render_frame',
	permission: 'read',
	description:
		'Look at the edit. Renders the exact frame at a TIMELINE time through the export pipeline — every ' +
		'track, effect, key, title and caption, as it will export — and returns it as an image. Use it to ' +
		'check framing, legibility and what is on screen before and after an edit. Takes a second or two. ' +
		'`note` is one short sentence on what you are checking; the user sees it beside the thumbnail.',
	inputSchema: {
		type: 'object',
		properties: {
			timeSec: { type: 'number', minimum: 0, description: 'Timeline seconds' },
			note: { type: 'string', description: 'What you are checking, in one short sentence' }
		},
		required: ['timeSec'],
		additionalProperties: false
	},
	title: (args) => `render_frame ${clock(Number(args.timeSec) || 0)}`,
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const end = computeContentEnd(project.doc.timeline)
		if (!project.doc.timeline.length || end <= 0) throw new ToolError('The timeline is empty — there is no frame to render.')
		const timeSec = Math.min(Math.max(0, Number(args.timeSec) || 0), Math.max(0, end - 0.001))
		const frame = await ctx.bridge.renderFrame(project, timeSec)
		return {
			content: [
				{ type: 'image', data: frame.data, mimeType: frame.mimeType },
				{
					type: 'text',
					text: [
						`Frame at ${clock(timeSec)} of ${clock(end)} (${project.doc.timelineMeta.width}×${project.doc.timelineMeta.height}).`,
						frame.motionNote
					].filter(Boolean).join('\n')
				}
			],
			feed: {
				title: `render_frame ${clock(timeSec)}`,
				thumbnail: frame.thumbnail,
				quote: typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined
			}
		}
	}
}


// ===== Sound =====

const SOUND_RECIPE_PROPS = {
	variant: { type: 'integer', minimum: 0, maximum: 4, description: 'Which take, for the sounds that have several (key has five, appear two)' },
	pitch: { type: 'number', minimum: -12, maximum: 12, description: 'Semitones. Keep the SAME pitch on every pitched sound and on the bed' },
	levelDb: { type: 'number', minimum: -40, maximum: 0, description: 'The sound’s peak in dBFS. Defaults to the sound’s own level; most never need it' },
	air: { type: 'number', minimum: 0, maximum: 1, description: 'How much airy noise a sweep (send, whoosh, swish, flight) carries. Default 0.4' },
	seed: { type: 'integer', minimum: 0, maximum: 9999, description: 'Which noise. The same seed is the same sound everywhere' },
	durationSec: { type: 'number', minimum: 0.2, maximum: 600, description: 'For the sounds that follow a move (flight, rise) and the ambient bed: how long' }
}
const FOLLOW_SCHEMA = {
	type: 'object',
	properties: {
		item: { type: 'string', description: 'The clip whose moment this sound is for (an id from get_timeline or suggest_cues)' },
		at: { type: 'string', enum: ['start', 'out', 'end'], description: 'start: its entrance or the cut into it. out: where a motion layer begins to leave. end: where it ends. Default start' },
		leadSec: { type: 'number', minimum: 0, maximum: 2, description: 'How early the sound starts. Leave it out: each sound has the right lead' }
	},
	required: ['item'],
	additionalProperties: false
}
/** Added to apply_ops over MCP only: the built-in AI’s own schema is unchanged. */
const SOUND_OPS_SCHEMA = {
	addSounds: {
		type: 'array',
		description:
			'Sounds from the built-in synth (read get_sound_guide first). Each is rendered by FrameFlow and placed on a free effects lane. ' +
			'Give follow {item, at} to land on a moment of another clip and stay there when it moves; or atSec for a fixed time.',
		items: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: SOUND_PRESETS.map((p) => p.kind), description: 'Which sound' },
				...SOUND_RECIPE_PROPS,
				atSec: { type: 'number', minimum: 0, description: 'Timeline seconds. Not needed with follow' },
				follow: FOLLOW_SCHEMA
			},
			required: ['kind'],
			additionalProperties: false
		}
	},
	setSounds: {
		type: 'array',
		description: 'Change a sound already on the timeline: its recipe (kind, pitch, levelDb, seed…) or the moment it follows. id is the sound’s item id from get_timeline.',
		items: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				kind: { type: 'string', enum: SOUND_PRESETS.map((p) => p.kind) },
				...SOUND_RECIPE_PROPS,
				follow: FOLLOW_SCHEMA,
				unfollow: { type: 'boolean', description: 'True stops it following anything' }
			},
			required: ['id'],
			additionalProperties: false
		}
	},
	placeAudio: {
		type: 'array',
		description:
			'Put a voice, effect or music that generate_audio made (or any audio already in the project) on the timeline. It lands on ' +
			'a free lane of the right role: voice-over on a voice lane, effects on an effects lane, music on a music lane. ' +
			'Free to use: only generate_audio costs money.',
		items: {
			type: 'object',
			properties: {
				asset: { type: 'string', description: 'The audio asset id generate_audio returned (or one from get_media)' },
				atSec: { type: 'number', minimum: 0, description: 'Timeline seconds. Not needed with follow' },
				follow: FOLLOW_SCHEMA,
				gain: { type: 'number', minimum: 0, maximum: 2, description: 'Level for this clip; 1 leaves it as made' }
			},
			required: ['asset'],
			additionalProperties: false
		}
	},
	setTrackRoles: {
		type: 'array',
		description: 'Say what an audio track is for. A music bed ducks under speech; the mix levels each role against the voice.',
		items: {
			type: 'object',
			properties: {
				trackId: { type: 'string' },
				role: { type: 'string', enum: ['voice', 'music', 'sfx', 'none'] }
			},
			required: ['trackId', 'role'],
			additionalProperties: false
		}
	}
}

const getSoundGuide: ToolDef = {
	name: 'get_sound_guide',
	permission: 'read',
	description:
		'How to use sound well. Every sound the synth makes with its length, level and lead; the roles and where each ' +
		'sits against the voice; the one rule about key; how to choose; and the loop to follow. You cannot hear: this ' +
		'and render_sound / analyze_audio are how you work by numbers. Read it before your first apply_ops with addSounds.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run() {
		return { content: [{ type: 'text', text: soundGuideText() }], feed: { detail: 'read the sound guide' } }
	}
}

const listSounds: ToolDef = {
	name: 'list_sounds',
	permission: 'read',
	description:
		'The palette of built-in sounds, and what is on this timeline now. Each palette sound: kind, group, what it is for, ' +
		'length, peak level, lead, takes. Then every synthesised sound already placed (item id, recipe, the moment it follows) ' +
		'and the audio tracks with their roles. Use the kinds with apply_ops addSounds.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run(_args, ctx) {
		const project = await requireProject(ctx)
		const { doc } = project
		const placed = doc.timeline.flatMap((i) => {
			const synth = doc.media.find((a) => a.id === i.sourceAssetId)?.synth
			return synth ? [{
				item: i.id, sound: synth.kind, variant: synth.variant, pitch: synth.pitch, levelDb: synth.levelDb, seed: synth.seed,
				atSec: r3(i.timelineStart), lengthSec: r3(i.duration),
				follows: i.bind ? { item: i.bind.itemId, at: i.bind.at } : undefined,
				track: doc.tracks.find((t) => t.id === i.trackId)?.name
			}] : []
		})
		const palette = SOUND_PRESETS.map((p) => ({
			kind: p.kind, group: p.group, label: p.label, for: p.description,
			lengthSec: p.follows ? 'as long as durationSec' : r3(soundLength({ kind: p.kind })),
			peakDb: p.level, leadMs: Math.round(p.lead * 1000), takes: p.variants
		}))
		const audioTracks = doc.tracks.filter((t) => t.kind === 'audio').map((t) => ({ id: t.id, name: t.name, role: t.role ?? null }))
		// What generate_audio could use right now, and the most it may spend in a turn.
		const status = ctx.bridge.audioStatus()
		const providers = {
			connected: PROVIDERS.filter((p) => status.connected.includes(p.id)).map((p) => ({ provider: p.id, makes: p.capabilities })),
			allowed: ctx.permissions().generate,
			limit: { generations: status.spend.maxGenerationsPerTurn, usd: status.spend.maxUsdPerTurn }
		}
		return {
			content: [json({ palette, placed, audioTracks, providers })],
			feed: { detail: `${palette.length} sounds · ${placed.length} on the timeline` }
		}
	}
}

const generateAudioTool: ToolDef = {
	name: 'generate_audio',
	permission: 'generate',
	writes: true,
	description:
		'Make a voice-over, a sound effect from a description, or music with an audio provider the user connected ' +
		'(list_sounds says which). It COSTS MONEY and is capped per turn, so use it only when the built-in sounds ' +
		'cannot do the job: spoken words, a sound with no built-in kind, a music bed. The result is a normal audio asset ' +
		'in the project (its id is returned); place it with apply_ops placeAudio. Nothing is placed by this call. ' +
		`Voice-over: prompt is the line to speak (up to ${LIMITS.speechChars.max} characters). Effects and music: prompt is a description ` +
		`(up to ${LIMITS.promptChars.max} characters), durationSec is ${LIMITS.sfxSec.min}–${LIMITS.sfxSec.max} s for an effect, ` +
		`${LIMITS.musicSec.min}–${LIMITS.musicSec.max} s for music. Say it once and check it with analyze_audio: do not make ` +
		'several takes to see which is best.',
	inputSchema: {
		type: 'object',
		properties: {
			capability: { type: 'string', enum: ['speech', 'sfx', 'music'], description: 'speech = a voice reading the prompt; sfx = a sound effect; music = a music bed' },
			prompt: { type: 'string', description: 'The line to speak, or a description of the sound' },
			provider: { type: 'string', enum: PROVIDERS.map((p) => p.id), description: 'Which provider. Omit to use a connected one that does this.' },
			voice: { type: 'string', description: 'Speech only: a voice name or id. Omit for the provider’s default.' },
			durationSec: { type: 'number', description: 'Effects and music: how long. Omit to let the provider choose.' }
		},
		required: ['capability', 'prompt'],
		additionalProperties: false
	},
	title: (args) => `generate_audio ${args.capability ?? ''}`.trim(),
	async run(args, ctx) {
		const project = await requireProject(ctx)
		if (!isCapability(args.capability)) throw new ToolError('capability must be speech, sfx or music.')
		const capability = args.capability as AudioCapability
		const status = ctx.bridge.audioStatus()
		const usable = PROVIDERS.filter((p) => status.connected.includes(p.id) && p.capabilities.includes(capability))
		if (args.provider !== undefined && !isProviderId(args.provider)) {
			throw new ToolError(`Unknown provider "${args.provider}". Providers: ${PROVIDERS.map((p) => p.id).join(', ')}.`)
		}
		const provider = args.provider ?? usable[0]?.id
		if (!provider || !status.connected.includes(provider)) {
			const wants = PROVIDERS.filter((p) => p.capabilities.includes(capability)).map((p) => p.label).join(' or ')
			throw new ToolError(
				`No audio provider is connected for ${CAPABILITY_LABEL[capability].toLowerCase()}. The user can connect ${wants} in ` +
				'Settings → Audio providers. Until then, use the built-in sounds (list_sounds) or tell the user what you would have made.'
			)
		}
		const req: GenerateRequest = {
			provider, capability, prompt: String(args.prompt ?? ''),
			...(typeof args.voice === 'string' && args.voice.trim() ? { voice: args.voice.trim() } : {}),
			...(typeof args.durationSec === 'number' ? { durationSec: args.durationSec } : {})
		}
		const problem = requestProblem(req)
		if (problem) throw new ToolError(problem)

		const spent = ctx.spent ?? { count: 0, usd: 0 }
		const estimate = ctx.bridge.estimateAudio(req)
		const decision = spendDecision(status.spend, spent, estimate)
		if (!decision.ok) throw new ToolError(decision.reason)

		const made = await ctx.bridge.generateAudio(project, req)
		spent.count += 1
		spent.usd += made.provenance.costUsd ?? estimate ?? 0
		const left = Math.max(0, status.spend.maxGenerationsPerTurn - spent.count)
		return {
			content: [json({
				asset: made.asset.id, name: made.asset.name, lengthSec: r3(made.asset.metadata?.duration),
				provider, cost: formatCost(made.provenance), generationsLeftThisTurn: left,
				next: 'Place it with apply_ops placeAudio {asset, atSec | follow}. Check it with analyze_audio if levels matter.'
			})],
			feed: {
				detail: `${CAPABILITY_LABEL[capability].toLowerCase()} · ${providerInfo(provider)!.label} · ${formatCost(made.provenance)}`,
				quote: req.prompt.length > 120 ? `${req.prompt.slice(0, 118)}…` : req.prompt,
				chips: [{ text: formatCost(made.provenance), tone: 'violet' }]
			}
		}
	}
}

const suggestCuesTool: ToolDef = {
	name: 'suggest_cues',
	permission: 'read',
	description:
		'The moments on this timeline that want a sound: a motion layer coming in and leaving, a cut between two clips, ' +
		'a transition, an end card. Each has the time, a label, the sound it suggests and why, whether it already has one ' +
		'(taken), and whether it is worth adding by default (suggested). The same list the user sees in “Sound the motion”. ' +
		'Pass a cue’s `follow` to apply_ops addSounds. Skip the ones you do not want: fewer is better.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run(_args, ctx) {
		const project = await requireProject(ctx)
		const cues = suggestCues({ tracks: project.doc.tracks, timeline: project.doc.timeline })
		const rows = cues.map((c) => ({
			cue: c.id, atSec: r3(c.atSec), label: c.label, sound: c.kind, why: c.reason,
			taken: c.taken, suggested: c.suggested,
			follow: { item: c.bind.itemId, at: c.bind.at },
			leadMs: Math.round(cueLead(c) * 1000)
		}))
		const open = cues.filter((c) => !c.taken)
		return {
			content: [json({ cues: rows, open: open.length })],
			feed: { detail: open.length ? `${open.length} moment${open.length === 1 ? '' : 's'} without a sound` : 'every moment has a sound', quote: open[0] ? describeCue(open[0]) : undefined }
		}
	}
}

const renderSoundTool: ToolDef = {
	name: 'render_sound',
	permission: 'read',
	description:
		'Hear a sound without hearing it: renders a recipe (or measures a sound already in the project) and returns its ' +
		'length, peak, loudness, and a spectrogram picture (time left to right, pitch bottom to top, loudness as brightness). ' +
		'Use it to check a recipe before you add it. Costs nothing and changes nothing in the project.',
	inputSchema: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: SOUND_PRESETS.map((p) => p.kind), description: 'A recipe to render…' },
			...SOUND_RECIPE_PROPS,
			item: { type: 'string', description: '…or a sound already on the timeline (its item id)' }
		},
		additionalProperties: false
	},
	title: (args) => `render_sound ${args.kind || args.item || ''}`.trim(),
	async run(args, ctx) {
		const project = await requireProject(ctx)
		let target: { recipe: SoundRecipe } | { assetId: string }
		let recipe: SoundRecipe | undefined
		if (args.item) {
			const item = project.doc.timeline.find((i) => i.id === args.item)
			const asset = item && project.doc.media.find((a) => a.id === item.sourceAssetId)
			if (!item || !asset) throw new ToolError(`No clip ${args.item}. Read get_timeline for ids.`)
			target = { assetId: asset.id }
			recipe = asset.synth
		} else {
			if (!isSoundKind(args.kind)) throw new ToolError(`Name a sound (kind) or a clip (item). The synth makes: ${SOUND_PRESETS.map((p) => p.kind).join(', ')}.`)
			recipe = { kind: args.kind }
			for (const f of ['variant', 'pitch', 'levelDb', 'air', 'seed', 'durationSec'] as const) {
				if (typeof args[f] === 'number') recipe[f] = args[f]
			}
			target = { recipe }
		}
		const report = await ctx.bridge.inspectSound(project, target)
		const n = recipe ? normaliseRecipe(recipe) : undefined
		const body = {
			recipe: n, lengthSec: r3(report.lengthSec),
			peakDb: report.truePeakDb === null ? null : r3(report.truePeakDb), loudnessLufs: report.lufs === null ? null : r3(report.lufs),
			renderedInMs: report.renderMs
		}
		const content: ToolContent[] = [json(body)]
		if (report.spectrogram) content.push({ type: 'image', data: report.spectrogram, mimeType: 'image/png' })
		return {
			content,
			feed: {
				detail: n ? `${presetOf(n.kind).label.toLowerCase()} · ${r3(report.lengthSec)} s · peak ${report.truePeakDb === null ? '—' : r3(report.truePeakDb)} dB` : undefined,
				thumbnail: report.spectrogram ? `data:image/png;base64,${report.spectrogram}` : undefined
			}
		}
	}
}

const analyzeAudio: ToolDef = {
	name: 'analyze_audio',
	permission: 'read',
	description:
		'How the mix sits: for each role (voice, music, sfx, unassigned) how many clips, their median loudness and loudest ' +
		'peak, every sounding clip with its estimated loudness and peak after gain, and warnings in words ("Music sits only ' +
		'2.0 LU under the voice…", "…will clip"). Estimated from each source’s measured loudness and the gain applied, so it ' +
		'is a fair picture of the whole, not the exported file; it says what it leaves out. Run it after adding sound and fix ' +
		'what it warns about. Optionally limit to a time range.',
	inputSchema: {
		type: 'object',
		properties: {
			fromSec: { type: 'number', description: 'Only clips that end after this timeline time' },
			toSec: { type: 'number', description: 'Only clips that start before this timeline time' }
		},
		additionalProperties: false
	},
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const { doc } = project
		const sounding = doc.timeline.filter((i) => !i.text && !i.generator && !i.motion && i.sourceAssetId)
			.filter((i) => args.fromSec === undefined || i.timelineStart + i.duration > args.fromSec)
			.filter((i) => args.toSec === undefined || i.timelineStart < args.toSec)
		const ids = [...new Set(sounding.map((i) => i.sourceAssetId))]
		const analyses = await ctx.bridge.audioAnalyses(project, ids)
		const report = estimateMix({ ...doc, timeline: sounding }, analyses)
		return {
			content: [json({
				...report,
				clips: report.clips.slice(0, 80).map((c) => ({ ...c, startSec: r3(c.startSec), endSec: r3(c.endSec) })),
				clipsTotal: report.clips.length,
				loudnessEnabled: !!doc.loudnessEnabled
			})],
			feed: { detail: report.warnings.length ? `${report.warnings.length} thing${report.warnings.length === 1 ? '' : 's'} to fix` : 'the mix sits well', quote: report.warnings[0] }
		}
	}
}

const OPS_BASE_SCHEMA = opsInputSchema(EDITOR_OPS_SCHEMA)
const OPS_INPUT_SCHEMA = { ...OPS_BASE_SCHEMA, properties: { ...OPS_BASE_SCHEMA.properties, ...SOUND_OPS_SCHEMA } } as typeof OPS_BASE_SCHEMA

const applyOps: ToolDef = {
	name: 'apply_ops',
	permission: 'edit',
	writes: true,
	description:
		'Edit the timeline. The arguments are FrameFlow’s edit operations — the same contract its built-in ' +
		'AI uses. The edit is applied to the editor at once, as one turn, and saved as a new revision (a V ' +
		'number) the user can undo or go back from. Returns that revision, any ops dropped as invalid, and ' +
		'notes. Times: timelineStart, atSec and removeRanges are TIMELINE seconds; in/out are SOURCE seconds. ' +
		'Read ids from get_timeline and get_media first. Prefer a few focused calls to one huge one — each ' +
		'is its own revision — and check the result with render_frame. Before sending a custom page in `html`, ' +
		'read get_motion_guide. Always include a short rationale: the user reads it.',
	inputSchema: OPS_INPUT_SCHEMA,
	alsoNeeds: (args) => (opsWriteHtml(args as EditorOps) ? 'html' : opsMakeSound(args as EditorOps) ? 'sound' : null),
	async run(args, ctx) {
		const errors = validateArgs(OPS_INPUT_SCHEMA, args)
		if (errors.length) throw new ToolError(`Invalid operations — nothing was changed:\n- ${errors.join('\n- ')}`)
		if (!opKeys(args).length) throw new ToolError('apply_ops needs at least one operation besides rationale.')

		const project = await requireProject(ctx)
		// A page an agent writes is checked — lint, then drawn twice in the hidden
		// window — BEFORE it replaces anything. One that fails is not applied; the
		// earlier page stays, and the agent is told what to fix.
		const vetted = await vetHtmlOps(args as EditorOps, project.doc, ctx.probeMotion)
		// The two renders of a frame that drew two ways, so the agent can SEE why.
		const evidence = vetted.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
		if (!opKeys(vetted.ops as Record<string, unknown>).length) {
			const message = `Nothing was changed. Every operation was rejected:\n- ${vetted.dropped.join('\n- ')}`
			if (!evidence.length) throw new ToolError(message)
			return {
				content: [{ type: 'text', text: message }, ...evidence],
				isError: true,
				feed: { detail: 'page rejected: it drew a frame two ways' }
			}
		}
		const ops = vetted.ops
		const turnId = randomUUID()
		// Sounds are made first (rendered by ffmpeg, cached by recipe) so the mapping can
		// place them; the renderer is handed the new assets with the turn.
		const wanted = soundRecipesOf(ops, project.doc)
		const rendered = wanted.length ? await ctx.bridge.prepareSounds(project, wanted) : []
		const soundAssets = new Map(wanted.map((r, i) => [recipeKey(r), rendered[i]]))
		const mapped = opsToDiff(ops, project.doc, { by: ctx.clientName, turnId }, soundAssets, vetted.definitions)
		const { diff, addMarkers, docSettings, notes } = mapped
		const droppedOps = [...vetted.dropped, ...mapped.droppedOps]
		const turn: PromptTurn = {
			id: turnId,
			personaId: project.doc.activePersonaId,
			prompt: `${ctx.clientName} edited over MCP`,
			baseStepId: project.doc.historyRef?.currentStepId || '',
			status: 'completed',
			diff,
			rationale: ops.rationale,
			droppedOps: droppedOps.length ? droppedOps : undefined,
			notes: notes.length ? notes : undefined,
			agent: { name: ctx.clientName, sessionId: ctx.sessionId, ...(ctx.engineTurnId ? { engineTurnId: ctx.engineTurnId } : {}) },
			createdAt: Date.now()
		}
		const outcome = await ctx.bridge.commitTurn({
			threadId: project.threadId,
			turn,
			addMarkers: addMarkers.length ? addMarkers : undefined,
			docSettings: Object.keys(docSettings).length ? docSettings : undefined,
			addAssets: rendered.length ? rendered : undefined
		})
		if (!outcome.ok) {
			const dropped = droppedOps.length ? `\nDropped as invalid:\n- ${droppedOps.join('\n- ')}` : ''
			throw new ToolError(`${outcome.error}${dropped}`)
		}
		const parent = versionLabel(project, outcome.parentRevisionId)
		return {
			content: [json({
				revision: `V${outcome.revisionSeq}`,
				revisionId: outcome.revisionId,
				undo: parent ? `revert_to_version ${parent.slice(1)} goes back to the state before this edit` : undefined,
				applied: outcome.counts,
				droppedOps: [...droppedOps, ...outcome.pruned],
				// Anything the live doc moved that the ops did not ask to (an overlap pushed right).
				notes: [...notes, ...(outcome.shifted ?? [])]
			}), ...evidence],
			feed: {
				detail: ops.rationale || undefined,
				chips: opChips(ops as Record<string, unknown>, outcome.revisionSeq)
			}
		}
	}
}

const getMotionGuide: ToolDef = {
	name: 'get_motion_guide',
	permission: 'read',
	description:
		'How to write a custom HTML motion page that is good, not just valid: the page contract (what is ' +
		'checked and refused) and the craft rules (fill the frame, match the project’s look, make subjects ' +
		'readable, ease and settle, time the beats exactly, declare keyframable fields with animate: true, ' +
		'verify with render_frame). Read it before the first apply_ops that sends `html`.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run() {
		return { content: [{ type: 'text', text: motionGuideText() }], feed: { detail: 'read the motion page guide' } }
	}
}

const revertToVersion: ToolDef = {
	name: 'revert_to_version',
	permission: 'edit',
	writes: true,
	description:
		'Go back to an earlier revision of the timeline — a V number from get_project or from an ' +
		'apply_ops result. Nothing is lost: the version you leave stays in the revision list, so this can ' +
		'itself be undone. Use it when render_frame shows an edit did not work.',
	inputSchema: {
		type: 'object',
		properties: { version: { type: 'integer', minimum: 0, description: 'The V number, e.g. 7 for V7' } },
		required: ['version'],
		additionalProperties: false
	},
	title: (args) => `revert_to_version V${args.version}`,
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const target = project.revisions.find((r) => r.seq === args.version)
		if (!target) {
			const known = [...project.revisions].sort((a, b) => a.seq - b.seq).map((r) => `V${r.seq}`).join(', ')
			throw new ToolError(`There is no V${args.version}. Revisions: ${known || 'none yet'}.`)
		}
		const result = await ctx.bridge.switchRevision(target.id)
		if (!result.ok) throw new ToolError(result.error)
		return {
			content: [json({ current: `V${target.seq}`, label: target.label })],
			feed: { detail: `back to V${target.seq} · ${target.label}`, chips: [{ text: `V${target.seq}`, tone: 'violet' }] }
		}
	}
}

const exportTool: ToolDef = {
	name: 'export',
	permission: 'export',
	description:
		'Render the timeline to a video file on disk (H.264 MP4, original quality), exactly as the Export ' +
		'button does. Refused unless the user has allowed agents to export — if it is, tell the user the ' +
		'edit is ready and ask them to press Export. Runs in the background; FrameFlow shows progress and ' +
		'the file lands in the project’s exports folder.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	async run(_args, ctx) {
		await requireProject(ctx)
		const result = await ctx.bridge.startExport()
		if (!result.ok) throw new ToolError(result.error)
		return { content: [{ type: 'text', text: result.detail }], feed: { detail: result.detail } }
	}
}

export const TOOLS: ToolDef[] = [
	getProject, getTimeline, getMedia, searchMomentsTool, renderFrame, getMotionGuide,
	getSoundGuide, listSounds, suggestCuesTool, renderSoundTool, analyzeAudio, generateAudioTool,
	applyOps, revertToVersion, exportTool
]

export const SERVER_INSTRUCTIONS =
	'FrameFlow is a video editor running on this computer; these tools act on the project the user has ' +
	'open in it, live. A good loop: get_project → get_timeline and get_media (or search_moments) to find ' +
	'material → apply_ops to edit (get_motion_guide first if you will write an HTML motion page) → ' +
	'render_frame to look at the result → revert_to_version if it is ' +
	'wrong. For sound: get_sound_guide, then suggest_cues → apply_ops addSounds (with follow) → analyze_audio; ' +
	'you cannot hear, so work by the numbers and the spectrogram render_sound gives. Spoken words or a sound the palette cannot make: generate_audio (costs money, capped) then apply_ops placeAudio. Every apply_ops is a revision the user can see and undo; the user may edit at the same time, ' +
	'so read the timeline again before each edit instead of relying on an old read.'
