import path, { join } from 'path'
import { YtDlp } from 'ytdlp-nodejs'
import fs from 'fs'
import { app } from 'electron'
import { getFFmpegBinaryPath } from './ffmpeg'
import { dependencyManager } from './dependencies/manager'
import { updateYtDlpForFailure } from './dependencies/ytdlp-updater'
import { isStaleYtDlpError } from './dependencies/ytdlp-version'

/** Self-heal progress markers surfaced to the UI during auto-recovery. */
export type YtDlpRecoveryPhase = 'updating-ytdlp' | 'retrying'

/**
 * Returns the absolute path to the yt-dlp binary.
 * 1. Checks for a manually downloaded version in userData.
 * 2. Checks for a bundled version in app.asar.unpacked.
 * 3. Falls back to the default node_modules path (dev).
 */
export function getYtDlpBinaryPath(): string {
	// 1. Check for downloaded version in userData/bin
	const downloadedPath = dependencyManager.getDownloadedYtDlpPath()
	if (downloadedPath && fs.existsSync(downloadedPath)) {
		return downloadedPath
	}

	// 2. Check for bundled version in node_modules (handling asar unpack)
	const platform = process.platform
	const filename = platform === 'darwin' ? 'yt-dlp_macos' : (platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

	// This assumes 'asarUnpack' was configured for **/node_modules/ytdlp-nodejs/bin/*
	let bundledPath = join(app.getAppPath(), 'node_modules/ytdlp-nodejs/bin', filename)

	// Fix for production path in asar
	if (bundledPath.includes('app.asar')) {
		bundledPath = bundledPath.replace('app.asar', 'app.asar.unpacked')
	}

	if (fs.existsSync(bundledPath)) {
		return bundledPath
	}

	// 3. Fallback to node_modules relative to this file (dev)
	// In dev with electron-vite, this file is in src/main/ytdlp.ts
	return join(process.cwd(), 'node_modules/ytdlp-nodejs/bin', filename)
}

/**
 * Always a fresh instance: the resolved binary path changes when an update
 * lands in userData/bin, and a module-level instance would pin the stale
 * binary until app restart — defeating the self-heal retry.
 */
function createYtDlp(): YtDlp {
	return new YtDlp({
		binaryPath: getYtDlpBinaryPath(),
		ffmpegPath: getFFmpegBinaryPath()
	})
}

/**
 * Runs a yt-dlp operation with self-heal: when the failure signature says the
 * binary is stale (403/Forbidden, extractor or nsig failures, bot checks),
 * update to the latest release and retry ONCE with a fresh instance. Update
 * attempts are throttled (once per hour per app run) inside
 * updateYtDlpForFailure; when throttled, the original error propagates.
 */
async function withYtDlpSelfHeal<T>(
	operation: (ytdlp: YtDlp) => Promise<T>,
	onRecoveryPhase?: (phase: YtDlpRecoveryPhase) => void
): Promise<T> {
	try {
		return await operation(createYtDlp())
	} catch (error: any) {
		if (!isStaleYtDlpError(error?.message)) throw error

		console.warn('[ytdlp] stale-binary signature detected, trying auto-update:', error?.message)
		onRecoveryPhase?.('updating-ytdlp')
		const updated = await updateYtDlpForFailure()
		if (!updated) throw error

		console.log('[ytdlp] updated, retrying the operation once')
		onRecoveryPhase?.('retrying')
		return await operation(createYtDlp())
	}
}

export async function checkYtDlpAvailability(): Promise<boolean> {
	try {
		// Fresh instance so path changes (like after a download) are picked up
		const checker = createYtDlp()
		const isInstalled = await checker.checkInstallationAsync()
		
		if (isInstalled) {
			dependencyManager.updateStatus('yt-dlp', { status: 'ready', progress: 100 })
		} else {
			dependencyManager.updateStatus('yt-dlp', { status: 'missing' })
		}
		
		return isInstalled
	} catch (error) {
		console.error('Failed to check yt-dlp availability:', error)
		dependencyManager.updateStatus('yt-dlp', { status: 'error', error: 'Check failed' })
		return false
	}
}

export async function getVideoFormats(
	url: string,
	onRecoveryPhase?: (phase: YtDlpRecoveryPhase) => void
): Promise<string[]> {
	try {
		return await withYtDlpSelfHeal(async (ytdlp) => {
			const info = await ytdlp.getInfoAsync(url)
			if (info._type !== 'video') {
				throw new Error('URL is not a single video (possible playlist or channel)')
			}
			const formats = info.formats || []
			const heights = new Set<number>()

			formats.forEach((f: any) => {
				if (f.height && f.height >= 144) {
					heights.add(f.height)
				}
			})

			// Sort descending: 1080, 720, 480...
			const sortedHeights = Array.from(heights)
				.sort((a, b) => b - a)
				.map(h => h.toString())

			return sortedHeights.length > 0 ? sortedHeights : ['Best']
		}, onRecoveryPhase)
	} catch (e: any) {
		console.error('Failed to fetch formats:', e)
		const message = e.message || 'Unknown error'
		// Specialize message for better UI feedback
		if (message.includes('Unsupported URL')) {
			throw new Error('Unsupported URL: yt-dlp does not support this website.')
		}
		throw new Error(`Failed to fetch video formats: ${message}`)
	}
}

export async function downloadVideo(
	url: string,
	tempFolder: string,
	resolution?: string,
	onProgress?: (percent: number) => void,
	onRecoveryPhase?: (phase: YtDlpRecoveryPhase) => void
): Promise<{ path: string; name: string }> {
	try {
		return await withYtDlpSelfHeal(
			(ytdlp) => runDownload(ytdlp, url, tempFolder, resolution, onProgress),
			onRecoveryPhase
		)
	} catch (error: any) {
		console.error('Download failed:', error)
		throw new Error(`yt-dlp download failed: ${error.message}`)
	}
}

/** The raw download + file normalization, on an explicit YtDlp instance. */
async function runDownload(
	ytdlp: YtDlp,
	url: string,
	tempFolder: string,
	resolution?: string,
	onProgress?: (percent: number) => void
): Promise<{ path: string; name: string }> {
	// Output template: tempFolder / videoTitle.ext
	const outputTemplate = join(tempFolder, '%(title)s.%(ext)s')

	const builder = ytdlp.download(url)
		.output(outputTemplate)
		.addArgs('--no-playlist')
		.addArgs('--ffmpeg-location', getFFmpegBinaryPath())

	if (resolution && resolution !== 'Best') {
		// quality() logic
		const formatStr = `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${resolution}][ext=mp4]/best`
		builder.addArgs('-f', formatStr)
	} else {
		const formatStr = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
		builder.addArgs('-f', formatStr)
	}

	if (onProgress) {
		builder.on('progress', (p) => {
			if (p.percentage !== undefined) {
				onProgress(p.percentage)
			}
		})
	}

	const result = await builder.run()

	let downloadedPath = result.filePaths?.[0]

	// 0. Safety: Check if we got anything
	if (!downloadedPath || !fs.existsSync(downloadedPath)) {
		// Fallback: scan the temp directory
		const files = fs.readdirSync(tempFolder)
		if (files.length > 0) {
			downloadedPath = join(tempFolder, files[0])
		}
	}

	if (!downloadedPath || !fs.existsSync(downloadedPath)) {
		throw new Error('No files found in temp folder after download')
	}

	// 1. Resolve 'Is a directory' issues
	// If yt-dlp created a directory (e.g. for folder link or failed merge), find the biggest file or merged file
	if (fs.statSync(downloadedPath).isDirectory()) {
		console.log(`[YTDLP] Download result is a directory: ${downloadedPath}. Resolving to flat file...`)
		const files = fs.readdirSync(downloadedPath)
			.map(f => ({ name: f, path: join(downloadedPath!, f), size: fs.statSync(join(downloadedPath!, f)).size }))
			.filter(f => !fs.statSync(f.path).isDirectory())
			.sort((a, b) => b.size - a.size) // Pick biggest file (likely the video)

		if (files.length === 0) {
			throw new Error('yt-dlp download failed: Result was an empty directory')
		}

		const bestFile = files[0]
		const newPath = join(tempFolder, bestFile.name)
		fs.renameSync(bestFile.path, newPath)

		// Cleanup the directory if it's now empty or just temp fragments
		try { fs.rmSync(downloadedPath, { recursive: true, force: true }) } catch (e) { }

		downloadedPath = newPath
	}

	// 2. Normalize filename
	const dir = path.dirname(downloadedPath)
	const originalFileName = path.basename(downloadedPath)

	// Robust normalization: strip redundant extensions
	const ext = path.extname(originalFileName)
	let base = path.basename(originalFileName, ext)

	// Keep stripping common video extensions from the end of the base name
	const videoExtensions = ['.mp4', '.m4a', '.webm', '.mov', '.mkv', '.avi', '.f136', '.f140', '.f251']
	while (true) {
		const subExt = path.extname(base)
		if (!subExt) break
		if (videoExtensions.includes(subExt.toLowerCase()) || subExt.match(/^\.f\d+$/)) {
			base = path.basename(base, subExt)
		} else {
			break
		}
	}

	const newFileName = `${base.trim()}${ext}`
	let finalPath = downloadedPath
	let finalName = originalFileName

	if (newFileName !== originalFileName) {
		const newPath = join(dir, newFileName)
		if (!fs.existsSync(newPath)) {
			fs.renameSync(downloadedPath, newPath)
			finalPath = newPath
			finalName = newFileName
		}
	}

	return { path: finalPath, name: finalName }
}



