import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Clip, MediaAsset, Thread } from '@shared/types'
import { threadManager } from '../threads'
import { getVideoMetadata, sanitizeFilename } from '../ffmpeg'
import { ASSET_DIRS, THREAD_DIRS } from '../constants/paths'
import { abortAssetPreprocessing } from './preprocess'

/**
 * Media-asset CRUD for the timeline editor.
 * Every artifact of an asset lives under tempDir/media/<assetId>/ so
 * concurrent imports can never collide and removal is one rm -rf.
 * All document writes go through threadManager.updateThreadWith (queued
 * mutators) so parallel per-asset updates cannot clobber each other.
 */

export function getAssetDir(thread: Thread, assetId: string): string {
	return path.join(thread.tempDir, THREAD_DIRS.MEDIA, assetId)
}

function ensureDir(dir: string) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Imports a source file as a MediaAsset: copies (or moves) it into the
 * asset's source/ dir, probes metadata, and persists the asset record.
 * A failed probe persists an error-state asset rather than throwing —
 * the UI shows it with a retry/remove affordance.
 */
export async function createMediaAsset(
	threadId: string,
	options: { sourcePath: string; name?: string; move?: boolean; assetId?: string; referenceInPlace?: boolean }
): Promise<MediaAsset | null> {
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor' || !thread.editor) return null

	if (!fs.existsSync(options.sourcePath) || fs.statSync(options.sourcePath).isDirectory()) {
		throw new Error(`Invalid media source: "${options.sourcePath}" is not a file.`)
	}

	const assetId = options.assetId || uuidv4()
	const assetDir = getAssetDir(thread, assetId)

	const rawName = options.name || path.basename(options.sourcePath)
	const fileName = sanitizeFilename(rawName)

	// Reference the user's file where it lives instead of copying it in.
	// Copying a large local source (10–15 GB) with fs.copyFileSync blocks the
	// main process and freezes the whole UI (including the file dialog). The
	// editor only needs the path: proxy/thumbnails/export read originalPath
	// directly, media:// serves any absolute path, removeAsset only clears the
	// asset dir, and path-repair leaves out-of-tempDir paths untouched. URL
	// imports still live under the asset dir (they download straight into it).
	let originalPath: string
	if (options.referenceInPlace) {
		originalPath = options.sourcePath
	} else {
		const sourceDir = path.join(assetDir, ASSET_DIRS.SOURCE)
		ensureDir(sourceDir)
		originalPath = path.join(sourceDir, fileName)
		if (path.resolve(options.sourcePath) !== path.resolve(originalPath)) {
			if (options.move) {
				fs.renameSync(options.sourcePath, originalPath)
			} else {
				fs.copyFileSync(options.sourcePath, originalPath)
			}
		}
	}

	const asset: MediaAsset = {
		id: assetId,
		kind: 'video',
		name: rawName,
		originalPath,
		preprocessing: {},
		preprocessState: 'pending',
		clips: [],
		createdAt: Date.now()
	}

	try {
		asset.metadata = await getVideoMetadata(originalPath)
	} catch (error) {
		console.error(`[editor] Failed to probe media ${originalPath}:`, error)
		asset.preprocessState = 'error'
		asset.preprocessError = 'Could not read video metadata (corrupt or unsupported file).'
	}

	await threadManager.updateThreadWith(threadId, (t) => {
		if (!t.editor) return null
		const patch: Partial<Thread> = { editor: { ...t.editor, media: [...t.editor.media, asset] } }
		// Auto-name the project after the first imported media while the title
		// is still the default — mirrors how chat threads name from the video.
		if (!t.title || t.title === 'Untitled Project') {
			const derived = deriveProjectTitle(rawName)
			if (derived) patch.title = derived
		}
		return patch
	})

	return asset
}

/** Filename → a clean project title: drop the extension, tidy separators. */
function deriveProjectTitle(fileName: string): string {
	const base = fileName.replace(/\.[^./\\]+$/, '') // strip a trailing extension
	return base.replace(/[_]+/g, ' ').trim().slice(0, 120)
}

/** Merge a partial patch into one asset record (queued, safe under concurrency). */
export function patchAsset(
	threadId: string,
	assetId: string,
	patch: Partial<MediaAsset> | ((asset: MediaAsset) => Partial<MediaAsset>)
): Promise<Thread | null> {
	return threadManager.updateThreadWith(threadId, (thread) => {
		if (!thread.editor) return null
		const index = thread.editor.media.findIndex((a) => a.id === assetId)
		if (index === -1) return null

		const current = thread.editor.media[index]
		const resolved = typeof patch === 'function' ? patch(current) : patch
		const media = [...thread.editor.media]
		media[index] = { ...current, ...resolved }
		return { editor: { ...thread.editor, media } }
	})
}

/** Merge a preprocessing patch into one asset (mirrors PipelineContext.savePreprocessing). */
export function patchAssetPreprocessing(
	threadId: string,
	assetId: string,
	patch: Partial<Thread['preprocessing']>
): Promise<Thread | null> {
	return patchAsset(threadId, assetId, (asset) => ({
		preprocessing: { ...(asset.preprocessing || {}), ...patch }
	}))
}

// ===== Scene-piece corrections (PRD §5.2 merge / split further) =====
// Clips are main-owned; these run through patchAsset's queued mutator and
// return the updated asset so the renderer can patch locally without waiting
// for the thread-updated echo.

const CLIP_ADJACENCY_EPSILON = 0.1 // seconds — detected scenes abut exactly
const MIN_SPLIT_PIECE_SEC = 0.2

function reindexClips(clips: Clip[]): Clip[] {
	return clips.map((c, i) => ({ ...c, index: i + 1 }))
}

function getUpdatedAsset(threadId: string, assetId: string): MediaAsset | null {
	return threadManager.getThread(threadId)?.editor?.media.find((a) => a.id === assetId) || null
}

/** Validate a merge selection; throws a user-facing error on rejection. */
function validateMergeTargets(asset: MediaAsset, clipIds: string[]): Clip[] {
	const targets = asset.clips
		.filter((c) => clipIds.includes(c.id))
		.sort((a, b) => a.in - b.in)
	if (targets.length < 2) throw new Error('Selected pieces no longer exist.')

	for (let i = 1; i < targets.length; i++) {
		if (Math.abs(targets[i].in - targets[i - 1].out) > CLIP_ADJACENCY_EPSILON) {
			throw new Error('Only adjacent pieces can be merged.')
		}
	}
	return targets
}

/**
 * Merge a run of ADJACENT clips (by source time) into one piece spanning
 * their union. Non-adjacent selections are rejected — merging across a hole
 * would silently swallow unselected content.
 *
 * Validation runs BEFORE the queued mutator (updateThreadWith swallows mutator
 * throws), so rejections propagate to the renderer; the mutator re-validates
 * and skips silently if the asset changed mid-flight.
 */
export async function mergeClips(
	threadId: string,
	assetId: string,
	clipIds: string[]
): Promise<MediaAsset | null> {
	if (clipIds.length < 2) throw new Error('Select at least two pieces to merge.')
	const current = getUpdatedAsset(threadId, assetId)
	if (!current) throw new Error('Asset not found.')
	validateMergeTargets(current, clipIds)

	await patchAsset(threadId, assetId, (asset) => {
		let targets: Clip[]
		try {
			targets = validateMergeTargets(asset, clipIds)
		} catch {
			return {} // asset changed mid-flight — skip, don't corrupt
		}

		const first = targets[0]
		const last = targets[targets.length - 1]
		const merged: Clip = {
			...first,
			out: last.out,
			duration: last.out - first.in,
			visual: targets.map((t) => t.visual).filter(Boolean).join(' ') || undefined,
			text: targets.map((t) => t.text).filter(Boolean).join(' ') || undefined,
			selected: true,
			masterSegmentIndex: undefined // spans multiple master scenes
		}

		const remainingIds = new Set(clipIds.filter((id) => id !== first.id))
		const clips = asset.clips
			.map((c) => (c.id === first.id ? merged : c))
			.filter((c) => !remainingIds.has(c.id))
		return { clips: reindexClips(clips) }
	})

	return getUpdatedAsset(threadId, assetId)
}

/**
 * Split one clip into two pieces at `atSec` (source seconds; defaults to the
 * midpoint). Both halves share the source thumbnail; the left half keeps the
 * original id so selection/inspector focus degrades gracefully.
 */
export async function splitClip(
	threadId: string,
	assetId: string,
	clipId: string,
	atSec?: number
): Promise<MediaAsset | null> {
	// Pre-validate outside the queued mutator (see mergeClips).
	const current = getUpdatedAsset(threadId, assetId)
	const candidate = current?.clips.find((c) => c.id === clipId)
	if (!candidate) throw new Error('Piece no longer exists.')
	const cutAt = atSec ?? candidate.in + candidate.duration / 2
	if (cutAt - candidate.in < MIN_SPLIT_PIECE_SEC || candidate.out - cutAt < MIN_SPLIT_PIECE_SEC) {
		throw new Error('Piece is too short to split.')
	}

	await patchAsset(threadId, assetId, (asset) => {
		const target = asset.clips.find((c) => c.id === clipId)
		if (!target) return {} // asset changed mid-flight — skip

		const at = atSec ?? target.in + target.duration / 2
		if (at - target.in < MIN_SPLIT_PIECE_SEC || target.out - at < MIN_SPLIT_PIECE_SEC) {
			return {}
		}

		const left: Clip = {
			...target,
			out: at,
			duration: at - target.in,
			selected: true,
			masterSegmentIndex: undefined // sub-range of a master scene
		}
		const right: Clip = {
			...target,
			id: uuidv4(),
			in: at,
			duration: target.out - at,
			selected: true,
			masterSegmentIndex: undefined
		}

		const clips = asset.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]))
		return { clips: reindexClips(clips) }
	})

	return getUpdatedAsset(threadId, assetId)
}

/**
 * Removes an asset: aborts any live preprocessing, deletes its artifact dir,
 * and drops the asset plus its clips, timeline items, and namespaced tasks.
 */
export async function removeAsset(threadId: string, assetId: string): Promise<boolean> {
	abortAssetPreprocessing(threadId, assetId)

	const thread = threadManager.getThread(threadId)
	if (!thread || !thread.editor) return false

	const assetDir = getAssetDir(thread, assetId)
	if (fs.existsSync(assetDir)) {
		try {
			fs.rmSync(assetDir, { recursive: true, force: true })
		} catch (error) {
			console.error(`[editor] Failed to delete asset dir ${assetDir}:`, error)
		}
	}

	const updated = await threadManager.updateThreadWith(threadId, (t) => {
		if (!t.editor) return null

		const backgroundTasks = { ...(t.backgroundTasks || {}) }
		for (const taskId of Object.keys(backgroundTasks)) {
			if (taskId.startsWith(`${assetId}:`)) delete backgroundTasks[taskId]
		}

		return {
			editor: {
				...t.editor,
				media: t.editor.media.filter((a) => a.id !== assetId),
				timeline: t.editor.timeline.filter((item) => item.sourceAssetId !== assetId)
			},
			backgroundTasks
		}
	})

	return updated !== null
}
