import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Clip, EnrichedTimelineSegment, Message, Thread } from '@shared/types'
import { MessageRole } from '@shared/types'
import { clipsFromSegments, computeContentEnd, segmentsToItems } from '@shared/timeline'
import { threadManager } from '../threads'
import { ASSET_DIRS } from '../constants/paths'
import { createMediaAsset, getAssetDir, patchAsset, patchAssetPreprocessing } from './assets'
import { deriveClipsFromTranscript, preprocessMediaAsset } from './preprocess'

/**
 * "Open in Editor" — fork a node of the AI graph into a real timeline project.
 *
 * The point of this module is NOT to convert a chat thread into an editor
 * project. It is to put the chat's existing artifacts exactly where
 * preprocessMediaAsset already looks for them, then let the normal chain run
 * and no-op. Every step of that chain has a skip-if-exists guard (proxy,
 * audio, transcript, scenes; thumbnails are per-clip), so a fully preprocessed
 * chat video costs one round of thumbnail extraction and nothing else — no
 * re-encode, no second scenedetect run, no re-billed Gemini transcription.
 *
 * Artifact policy: the two big files (proxy, extracted audio) are HARD-LINKED
 * rather than referenced in place, because deleting the source chat thread
 * rm -rf's its whole tempDir. A hard link keeps the inode alive, costs zero
 * bytes, and puts every path under the editor thread's own tempDir where
 * repairThreadPaths can fix it. The small JSON artifacts are copied outright.
 */

export interface PromoteOptions {
	threadId: string
	/** 'root-media' (whole source, empty timeline) or a result Message.id (its AI cut on V1). */
	nodeId: string
}

export interface PromoteResult {
	editorThreadId: string
	/** The "manual edit" Message written back into the source graph. */
	messageId: string
	/** Artifacts that could not be reused; the chain recomputes them. */
	warnings: string[]
}

export const ROOT_MEDIA_NODE_ID = 'root-media'

/**
 * One promote per (thread, node) at a time. Load-bearing beyond convenience:
 * addMessageToThread builds `messages: [...current, new]` BEFORE queuing, so
 * two concurrent adds would lose one.
 */
const inFlight = new Map<string, Promise<PromoteResult>>()

const exists = (p?: string): p is string => !!p && fs.existsSync(p)

const ensureDir = (dir: string) => {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Hard-link, falling back to a copy across filesystems. Both roots normally
 * live under the same artifact dir, so the link almost always succeeds.
 */
function linkOrCopy(src: string, dest: string): void {
	ensureDir(path.dirname(dest))
	if (fs.existsSync(dest)) return
	try {
		fs.linkSync(src, dest)
	} catch {
		fs.copyFileSync(src, dest)
	}
}

/**
 * The manual-edit node already present for this graph node, if any, and whether
 * the project it points at still exists. A stale node is REUSED rather than
 * duplicated: re-forking rewrites its editorThreadId in place, so the canvas
 * never accumulates dead "Manual edit" nodes.
 */
function findExistingFork(
	source: Thread, nodeId: string
): { message: Message; live: boolean } | null {
	const parentId = nodeId === ROOT_MEDIA_NODE_ID ? undefined : nodeId
	const match = source.messages.find(
		(m) => m.editorThreadId && m.editRefId === parentId
	)
	if (!match) return null
	return { message: match, live: !!threadManager.getThread(match.editorThreadId!) }
}

/**
 * Decide where the editor's copy of the source video lives.
 *
 * A yt-dlp download was MOVED into the chat thread's tempDir by createThread,
 * so it dies with that thread — hard-link it out. A file the user picked from
 * their own disk is referenced in place, exactly as a normal editor import does
 * (copying a 10-15 GB source would block the main process).
 */
function materializeSource(source: Thread, editorThread: Thread, assetId: string): string {
	const videoPath = source.videoPath!
	const insideSourceThread = source.tempDir && videoPath.startsWith(source.tempDir)
	if (!insideSourceThread) return videoPath

	const dest = path.join(
		getAssetDir(editorThread, assetId), ASSET_DIRS.SOURCE, path.basename(videoPath)
	)
	try {
		linkOrCopy(videoPath, dest)
		return dest
	} catch {
		return videoPath // better a fragile reference than no project at all
	}
}

export interface SeedAction {
	src: string
	dest: string
	/** Big media is hard-linked so it survives deletion of the source thread. */
	mode: 'link' | 'copy'
}

export interface ArtifactSeedPlan {
	actions: SeedAction[]
	patch: Partial<Thread['preprocessing']>
	/** Set only when a proxy was reused; mirrors patch.lowResVideoPath. */
	proxyPath?: string
}

/**
 * Decide which chat artifacts to reuse and under WHICH FILENAMES — pure, so the
 * table can be asserted without touching disk. Every destination name here has
 * to match exactly what the corresponding preprocess step writes, or its
 * skip-if-exists guard misses and the work is redone (for the transcript, at
 * real Gemini cost).
 */
export function planArtifactSeed(
	pre: Thread['preprocessing'] | undefined,
	assetDir: string,
	existsFn: (p?: string) => boolean = exists
): ArtifactSeedPlan {
	const p = pre || {}
	const actions: SeedAction[] = []
	const patch: Partial<Thread['preprocessing']> = {}

	const take = (
		src: string | undefined, subDir: string, fileName: string, mode: 'link' | 'copy'
	): string | undefined => {
		if (!src || !existsFn(src)) return undefined
		const dest = path.join(assetDir, subDir, fileName)
		actions.push({ src, dest, mode })
		return dest
	}

	// Proxy. NOTE: the chat proxy is made without an fps cap while the editor's
	// own step caps >30fps to 30. We reuse the chat proxy as-is — re-encoding to
	// make them byte-identical would cost minutes to shift scene boundaries by at
	// most one frame, and the final export reads originalPath regardless.
	const proxy = p.lowResVideoPath
		? take(p.lowResVideoPath, ASSET_DIRS.PROXY, path.basename(p.lowResVideoPath), 'link')
		: undefined
	if (proxy) patch.lowResVideoPath = proxy

	const audio = p.audioPath
		? take(p.audioPath, ASSET_DIRS.AUDIO, path.basename(p.audioPath), 'link')
		: undefined
	if (audio) patch.audioPath = audio

	// The transcript skip guard tests rawTranscriptPath, NOT transcriptPath —
	// miss this one and the next run re-bills a full Gemini transcription.
	const raw = take(p.rawTranscriptPath, 'transcripts', 'raw_transcript.json', 'copy')
	if (raw) patch.rawTranscriptPath = raw

	const corrected = take(
		p.correctedTranscriptPath, 'transcripts', 'corrected_transcript.json', 'copy'
	)
	if (corrected) patch.correctedTranscriptPath = corrected

	// The editor's own runs point transcriptPath at the raw file; the chat flow
	// produces a corrected pass too, which is a strict superset. Prefer it.
	if (corrected || raw) patch.transcriptPath = corrected || raw

	const scenes = take(p.sceneTimesPath, ASSET_DIRS.ANALYSIS, 'scenes.json', 'copy')
	if (scenes) patch.sceneTimesPath = scenes

	const descriptions = take(
		p.sceneDescriptionsPath, ASSET_DIRS.ANALYSIS, 'scene_descriptions.json', 'copy'
	)
	if (descriptions) patch.sceneDescriptionsPath = descriptions

	return { actions, patch, proxyPath: proxy }
}

/**
 * Execute a seed plan. A failed action drops its field from the patch so the
 * normal chain recomputes that artifact — degradation is automatic.
 */
async function seedAssetArtifacts(
	source: Thread, editorThread: Thread, assetId: string
): Promise<string[]> {
	const warnings: string[] = []
	const plan = planArtifactSeed(source.preprocessing, getAssetDir(editorThread, assetId))
	const failed = new Set<string>()

	for (const action of plan.actions) {
		try {
			if (action.mode === 'link') linkOrCopy(action.src, action.dest)
			else {
				ensureDir(path.dirname(action.dest))
				fs.copyFileSync(action.src, action.dest)
			}
		} catch (e: any) {
			failed.add(action.dest)
			warnings.push(`Could not reuse ${path.basename(action.dest)}: ${e?.message || e}`)
		}
	}

	const patch = Object.fromEntries(
		Object.entries(plan.patch).filter(([, dest]) => !failed.has(dest as string))
	) as Partial<Thread['preprocessing']>

	if (plan.proxyPath && !failed.has(plan.proxyPath)) {
		await patchAsset(editorThread.id, assetId, { proxyPath: plan.proxyPath })
	}
	if (Object.keys(patch).length) {
		await patchAssetPreprocessing(editorThread.id, assetId, patch)
	}
	return warnings
}

/** Read the chat flow's enriched master timeline, if it produced one. */
function readEnrichedSegments(source: Thread): EnrichedTimelineSegment[] | null {
	const p = source.preprocessing?.enrichedTranscriptPath
	if (!exists(p)) return null
	try {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
		return Array.isArray(parsed) && parsed.length ? (parsed as EnrichedTimelineSegment[]) : null
	} catch {
		return null
	}
}

/**
 * Fill the clip tray, best source first.
 *
 * The enriched transcript is strictly the best rung: it is the same set of
 * pieces the chat AI reasoned about, and it carries both `text` and `visual`,
 * so the tray arrives fully populated without a Gemini descriptions call.
 */
async function seedClips(
	source: Thread, editorThreadId: string, assetId: string, durationLimit?: number
): Promise<void> {
	const segments = readEnrichedSegments(source)
	if (segments) {
		const clips = clipsFromSegments(segments, assetId, uuidv4, { durationLimit })
		if (clips.length) {
			await patchAsset(editorThreadId, assetId, { clips })
			return
		}
	}
	// Rung 2: derive from the transcript we just seeded. Must happen before
	// preprocessMediaAsset runs, or the transcript skip guard won't fire.
	await deriveClipsFromTranscript(editorThreadId, assetId)
	// Rung 3: no transcript either — runScenesStep derives from scenes.json.
}

/** Lay an AI cut onto the V1 track. Root-media promotes leave the timeline empty. */
async function seedTimeline(
	source: Thread, editorThreadId: string, segments: EnrichedTimelineSegment[], assetId: string
): Promise<void> {
	const thread = threadManager.getThread(editorThreadId)
	if (!thread?.editor) return

	const videoTrack = thread.editor.tracks.find((t) => t.kind === 'video')
	if (!videoTrack) return

	const clips: Clip[] = thread.editor.media.find((a) => a.id === assetId)?.clips || []
	const items = segmentsToItems(segments, videoTrack.id, { clips, assetId })
	if (!items.length) return

	const meta = source.videoMetadata
	await threadManager.updateThreadWith(editorThreadId, (t) => {
		if (!t.editor) return null
		return {
			editor: {
				...t.editor,
				timeline: items,
				timelineMeta: {
					...t.editor.timelineMeta,
					duration: computeContentEnd(items),
					fps: meta?.fps || t.editor.timelineMeta.fps,
					width: meta?.width || t.editor.timelineMeta.width,
					height: meta?.height || t.editor.timelineMeta.height
				}
			}
		}
	})
	// Deliberately NO history step: historyRef stays at the seeded baseline so
	// Cmd-Z immediately after opening cannot undo the project into emptiness.
}

async function runPromote(o: PromoteOptions): Promise<PromoteResult> {
	const { threadId, nodeId } = o
	const source = threadManager.getThread(threadId)

	if (!source) throw new Error('That project could not be found.')
	if (source.type === 'editor') throw new Error('This is already a timeline project.')

	const isRoot = nodeId === ROOT_MEDIA_NODE_ID
	const sourceMessage = isRoot ? null : source.messages.find((m) => m.id === nodeId)
	if (!isRoot && !sourceMessage) throw new Error('That node could not be found.')

	const segments = sourceMessage?.timeline
	if (!isRoot && !segments?.length) {
		throw new Error('This result has no timeline to open in the editor.')
	}
	if (!exists(source.videoPath)) {
		throw new Error('The source video is missing. Re-locate it and try again.')
	}

	// Already forked and still alive? Reuse it rather than making a second project.
	const existing = findExistingFork(source, nodeId)
	if (existing?.live) {
		return {
			editorThreadId: existing.message.editorThreadId!,
			messageId: existing.message.id,
			warnings: []
		}
	}

	// Number the forks rather than borrowing Message.version: the pipeline stamps
	// that with Date.now() (pipeline/index.ts), which would read as
	// "— Edit v1776265946257". Existing forks are the natural counter.
	const forkCount = source.messages.filter((m) => m.editorThreadId).length
	const title = isRoot
		? source.title
		: `${source.title} — Edit${forkCount ? ` ${forkCount + 1}` : ''}`

	// A real title also suppresses createMediaAsset's auto-rename.
	const editorThread = await threadManager.createEditorThread(title)

	try {
		await threadManager.updateThread(editorThread.id, {
			sourceThreadId: source.id,
			sourceNodeId: nodeId
		})

		const assetId = uuidv4()
		const originalPath = materializeSource(source, editorThread, assetId)
		const asset = await createMediaAsset(editorThread.id, {
			sourcePath: originalPath,
			name: path.basename(source.videoPath!),
			assetId,
			referenceInPlace: true // materializeSource already decided where the bytes live
		})
		if (!asset) throw new Error('Could not add the source video to the new project.')

		const warnings = await seedAssetArtifacts(source, editorThread, assetId)
		await seedClips(source, editorThread.id, assetId, asset.metadata?.duration)

		if (!isRoot && segments) {
			await seedTimeline(source, editorThread.id, segments, assetId)
		}

		// Everything is in place: the chain now skips down to thumbnails.
		preprocessMediaAsset(editorThread.id, assetId).catch((e) =>
			console.error('[promote] preprocessing failed:', e)
		)

		// Re-fork of a deleted project: repoint the node that's already on the
		// canvas instead of leaving a dead one beside a new one.
		if (existing) {
			await threadManager.updateMessageInThread(source.id, existing.message.id, {
				editorThreadId: editorThread.id
			})
			return { editorThreadId: editorThread.id, messageId: existing.message.id, warnings }
		}

		const message = await threadManager.addMessageToThread(source.id, {
			role: MessageRole.AI,
			content: 'Manual edit',
			isPending: false,
			editRefId: isRoot ? undefined : nodeId,
			resultType: 'editor',
			editorThreadId: editorThread.id,
			version: threadManager.getNextVersion(source.id)
		})
		if (!message) throw new Error('Could not add the edit node to the graph.')

		return { editorThreadId: editorThread.id, messageId: message.id, warnings }
	} catch (e) {
		// Never leave a half-built project on Home.
		try {
			threadManager.deleteThread(editorThread.id)
		} catch (cleanupError) {
			console.error('[promote] rollback failed:', cleanupError)
		}
		throw e
	}
}

export async function promoteToEditor(o: PromoteOptions): Promise<PromoteResult> {
	const key = `${o.threadId}:${o.nodeId}`
	const running = inFlight.get(key)
	if (running) return running

	const promise = runPromote(o).finally(() => inFlight.delete(key))
	inFlight.set(key, promise)
	return promise
}
