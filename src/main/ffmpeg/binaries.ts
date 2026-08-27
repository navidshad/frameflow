import { existsSync } from 'fs'
import { join, dirname } from 'path'

/**
 * Resolves the vendored FFmpeg and FFprobe executables.
 *
 * These are fetched and licence-checked by scripts/fetch-ffmpeg.mjs into
 * vendor/ffmpeg/, and copied into the packaged app by electron-builder's
 * `extraResources` block. They replaced the ffmpeg-static and ffprobe-static
 * npm packages: ffmpeg-static resolved a different upstream per platform, and
 * its darwin-arm64 build was configured --enable-nonfree, which cannot legally
 * be redistributed. See THIRD-PARTY-NOTICES.md section 2.
 *
 * This module deliberately imports nothing from `electron`. The scdet tests
 * need the same binary the app uses, and importing `app` here would drag an
 * Electron main process into a plain vitest run.
 */

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Finds vendor/ffmpeg by walking up from a starting directory. Dev servers and
 * vitest both run from somewhere inside the repo, but not always the root.
 */
function findVendorDir(from: string): string | null {
	let dir = from
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'vendor', 'ffmpeg')
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

/**
 * The directory holding the binaries.
 * 1. FRAMEFLOW_FFMPEG_DIR, for debugging against a different build.
 * 2. resourcesPath/ffmpeg — where extraResources lands them in a packaged app.
 *    Absent in dev, where resourcesPath points into Electron's own bundle.
 * 3. vendor/ffmpeg somewhere above the cwd — dev and tests.
 */
export function getFFmpegDir(): string {
	const override = process.env.FRAMEFLOW_FFMPEG_DIR
	if (override && existsSync(override)) return override

	if (process.resourcesPath) {
		const packaged = join(process.resourcesPath, 'ffmpeg')
		if (existsSync(packaged)) return packaged
	}

	const dev = findVendorDir(process.cwd())
	if (dev) return dev

	throw new Error(
		'FFmpeg binaries not found. Run `node scripts/fetch-ffmpeg.mjs` (npm install does this automatically).'
	)
}

/** Absolute path to the bundled ffmpeg executable. */
export function getFFmpegBinaryPath(): string {
	return join(getFFmpegDir(), `ffmpeg${EXE}`)
}

/** Absolute path to the bundled ffprobe executable. */
export function getFFprobeBinaryPath(): string {
	return join(getFFmpegDir(), `ffprobe${EXE}`)
}
