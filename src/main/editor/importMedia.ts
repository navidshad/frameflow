import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { MediaAsset } from '@shared/types'
import { threadManager } from '../threads'
import { downloadVideo } from '../ytdlp'
import { settingsManager } from '../settings'
import { importKindOf, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from '@shared/mediaFiles'
import * as editorAssets from './assets'
import * as editorPreprocess from './preprocess'

/**
 * Bringing media into an editor project: a link (YouTube and the other sites
 * yt-dlp reads) downloaded straight into the asset's folder, or a file on
 * disk. Either way the asset is recorded and its preprocessing (proxy, scenes,
 * transcript) starts in the background. The Media panel's import and the MCP
 * `import_media` tool share it, so an agent's import is the user's import.
 */

export type ImportPhase = 'updating-ytdlp' | 'retrying'

export interface ImportProgress {
	(percent: number, phase?: ImportPhase): void
}

function startPreprocess(threadId: string, asset: MediaAsset | null): void {
	if (!asset || asset.preprocessState === 'error') return
	// Fire-and-forget: progress streams over background-task-update.
	editorPreprocess.preprocessMediaAsset(threadId, asset.id).catch((error) => {
		console.error(`[editor] preprocess failed for ${asset.id}:`, error)
	})
}

/** Download a link into a new asset. The asset id is chosen first so progress can name it. */
export async function importMediaFromUrl(
	threadId: string,
	url: string,
	options: { resolution?: string; assetId?: string; onProgress?: (assetId: string, percent: number, phase?: ImportPhase) => void } = {}
): Promise<MediaAsset | null> {
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor') throw new Error('Not an editor project')

	const assetId = options.assetId ?? uuidv4()
	const sourceDir = path.join(thread.tempDir, 'media', assetId, 'source')
	fs.mkdirSync(sourceDir, { recursive: true })
	try {
		const result = await downloadVideo(
			url, sourceDir, options.resolution,
			(percent) => options.onProgress?.(assetId, percent),
			(phase) => options.onProgress?.(assetId, 0, phase)
		)
		const asset = await editorAssets.createMediaAsset(threadId, { sourcePath: result.path, name: result.name, assetId })
		startPreprocess(threadId, asset)
		return asset
	} catch (error) {
		// A failed import leaves nothing behind.
		try { fs.rmSync(path.join(thread.tempDir, 'media', assetId), { recursive: true, force: true }) } catch { /* best effort */ }
		throw error
	}
}

/**
 * Import a file on disk. The user's own file is referenced where it lives
 * (copying a multi-GB source would block the main process); a file the app
 * itself downloaded to a scratch folder is moved in.
 */
export async function importMediaFromFile(
	threadId: string,
	filePath: string,
	name?: string,
	options: { /** A file that cannot be read is an error, and leaves no asset behind (a batch lists it; a lone import keeps the asset with its error and a Retry). */ discardUnreadable?: boolean } = {}
): Promise<MediaAsset | null> {
	const resolved = path.resolve(filePath)
	if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) throw new Error(`There is no file at ${resolved}.`)
	if (!importKindOf(resolved)) {
		throw new Error(`${path.basename(resolved)} is not a video or audio file FrameFlow imports (${[...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join(' ')}).`)
	}
	// Match the download scratch dirs specifically: the artifact root holds every project.
	const isFreshDownload = resolved.startsWith(path.join(settingsManager.getTempDir(), 'download-'))
	const asset = await editorAssets.createMediaAsset(threadId, {
		sourcePath: resolved, name, referenceInPlace: !isFreshDownload, move: isFreshDownload
	})
	if (options.discardUnreadable && asset?.preprocessState === 'error') {
		const reason = asset.preprocessError || 'Could not read media metadata (corrupt or unsupported file).'
		await editorAssets.removeAsset(threadId, asset.id)
		throw new Error(reason)
	}
	startPreprocess(threadId, asset)
	return asset
}
