import { randomUUID } from 'node:crypto'
import type { EditorOps, MediaAsset, PromptTurn, TimelineItem } from '@shared/types'
import { opKeys, opsInputSchema, validateArgs, type AgentPermission, type AgentPermissions, type JsonSchema } from '@shared/agent'
import {
	clock, countWords, opChips, pageRows, searchMoments, summarizeMedia, summarizeSearch, summarizeTimeline,
	transcriptHealthLabel, type AgentChip, type SearchSource
} from '@shared/agentFeed'
import { allEffects } from '@shared/effects'
import { TRANSITION_PRESETS } from '@shared/transitionPresets'
import { computeContentEnd } from '@shared/timeline'
import { EDITOR_OPS_SCHEMA, opsToDiff } from '../editor/ops'
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

function describeItem(item: TimelineItem, names: Map<string, string>) {
	const { masterSegmentIndex, sourceClipId, preservePitch, ...rest } = item
	return {
		...rest,
		asset: item.sourceAssetId ? names.get(item.sourceAssetId) : undefined,
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
				read: true, editTimeline: perms.edit, writeHtmlMotion: perms.html, exportVideos: perms.export
			},
			catalog: {
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
		'seconds. Never cached: read it again after the user edits. Paged — pass nextOffset as offset to read on.',
	inputSchema: {
		type: 'object',
		properties: {
			offset: { type: 'integer', minimum: 0, description: 'First item to return (from nextOffset)' },
			limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Items per page (default 200)' },
			trackId: { type: 'string', description: 'Only this track' },
			fromSec: { type: 'number', description: 'Only items that end after this timeline time' },
			toSec: { type: 'number', description: 'Only items that start before this timeline time' }
		},
		additionalProperties: false
	},
	async run(args, ctx) {
		const project = await requireProject(ctx)
		const { doc } = project
		const names = new Map(doc.media.map((a) => [a.id, a.name]))
		const items = [...doc.timeline]
			.filter((i) => !args.trackId || i.trackId === args.trackId)
			.filter((i) => args.fromSec === undefined || i.timelineStart + i.duration > args.fromSec)
			.filter((i) => args.toSec === undefined || i.timelineStart < args.toSec)
			.sort((a, b) => a.timelineStart - b.timelineStart)
			.map((i) => describeItem(i, names))
		const page = pageRows(items, { offset: args.offset, limit: args.limit ?? 200, maxChars: 60_000 })
		return {
			content: [json({
				durationSec: r3(computeContentEnd(doc.timeline)),
				currentRevision: versionLabel(project, project.currentRevisionId),
				items: page.rows, offset: page.offset, total: page.total, nextOffset: page.nextOffset
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
				{ type: 'text', text: `Frame at ${clock(timeSec)} of ${clock(end)} (${project.doc.timelineMeta.width}×${project.doc.timelineMeta.height}).` }
			],
			feed: {
				title: `render_frame ${clock(timeSec)}`,
				thumbnail: frame.thumbnail,
				quote: typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined
			}
		}
	}
}

const OPS_INPUT_SCHEMA = opsInputSchema(EDITOR_OPS_SCHEMA)

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
		'is its own revision — and check the result with render_frame. Always include a short rationale: ' +
		'the user reads it.',
	inputSchema: OPS_INPUT_SCHEMA,
	async run(args, ctx) {
		const errors = validateArgs(OPS_INPUT_SCHEMA, args)
		if (errors.length) throw new ToolError(`Invalid operations — nothing was changed:\n- ${errors.join('\n- ')}`)
		if (!opKeys(args).length) throw new ToolError('apply_ops needs at least one operation besides rationale.')

		const project = await requireProject(ctx)
		const ops = args as EditorOps
		const { diff, addMarkers, docSettings, droppedOps, notes } = opsToDiff(ops, project.doc)
		const turn: PromptTurn = {
			id: randomUUID(),
			personaId: project.doc.activePersonaId,
			prompt: `${ctx.clientName} edited over MCP`,
			baseStepId: project.doc.historyRef?.currentStepId || '',
			status: 'completed',
			diff,
			rationale: ops.rationale,
			droppedOps: droppedOps.length ? droppedOps : undefined,
			notes: notes.length ? notes : undefined,
			agent: { name: ctx.clientName, sessionId: ctx.sessionId },
			createdAt: Date.now()
		}
		const outcome = await ctx.bridge.commitTurn({
			threadId: project.threadId,
			turn,
			addMarkers: addMarkers.length ? addMarkers : undefined,
			docSettings: Object.keys(docSettings).length ? docSettings : undefined
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
				notes
			})],
			feed: {
				detail: ops.rationale || undefined,
				chips: opChips(args, outcome.revisionSeq)
			}
		}
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
	getProject, getTimeline, getMedia, searchMomentsTool, renderFrame, applyOps, revertToVersion, exportTool
]

export const SERVER_INSTRUCTIONS =
	'FrameFlow is a video editor running on this computer; these tools act on the project the user has ' +
	'open in it, live. A good loop: get_project → get_timeline and get_media (or search_moments) to find ' +
	'material → apply_ops to edit → render_frame to look at the result → revert_to_version if it is ' +
	'wrong. Every apply_ops is a revision the user can see and undo; the user may edit at the same time, ' +
	'so read the timeline again before each edit instead of relying on an old read.'
