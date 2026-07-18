import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { MediaAsset, Thread } from '@shared/types'
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
	options: { sourcePath: string; name?: string; move?: boolean; assetId?: string }
): Promise<MediaAsset | null> {
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor' || !thread.editor) return null

	if (!fs.existsSync(options.sourcePath) || fs.statSync(options.sourcePath).isDirectory()) {
		throw new Error(`Invalid media source: "${options.sourcePath}" is not a file.`)
	}

	const assetId = options.assetId || uuidv4()
	const assetDir = getAssetDir(thread, assetId)
	const sourceDir = path.join(assetDir, ASSET_DIRS.SOURCE)
	ensureDir(sourceDir)

	const rawName = options.name || path.basename(options.sourcePath)
	const fileName = sanitizeFilename(rawName)
	const targetPath = path.join(sourceDir, fileName)

	// Only copy/move if the file isn't already inside the asset's source dir
	// (URL imports download straight into it).
	if (path.resolve(options.sourcePath) !== path.resolve(targetPath)) {
		if (options.move) {
			fs.renameSync(options.sourcePath, targetPath)
		} else {
			fs.copyFileSync(options.sourcePath, targetPath)
		}
	}

	const asset: MediaAsset = {
		id: assetId,
		kind: 'video',
		name: rawName,
		originalPath: targetPath,
		preprocessing: {},
		preprocessState: 'pending',
		clips: [],
		createdAt: Date.now()
	}

	try {
		asset.metadata = await getVideoMetadata(targetPath)
	} catch (error) {
		console.error(`[editor] Failed to probe media ${targetPath}:`, error)
		asset.preprocessState = 'error'
		asset.preprocessError = 'Could not read video metadata (corrupt or unsupported file).'
	}

	await threadManager.updateThreadWith(threadId, (t) => {
		if (!t.editor) return null
		return { editor: { ...t.editor, media: [...t.editor.media, asset] } }
	})

	return asset
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
