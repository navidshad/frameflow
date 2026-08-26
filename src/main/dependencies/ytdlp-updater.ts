import { app, net } from 'electron'
import { execFile } from 'child_process'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { dependencyManager } from './manager'
import { isNewerYtDlpVersion } from './ytdlp-version'
import { getYtDlpBinaryPath } from '../ytdlp'

// The proactive startup check runs at most weekly; the reactive (failure-
// triggered) update at most hourly per app run. Both funnel into the same
// latched installYtDlp, so concurrent triggers share one download.
const STARTUP_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const FAILURE_UPDATE_INTERVAL_MS = 60 * 60 * 1000
const VERSION_PROBE_TIMEOUT_MS = 10_000

const CHECK_MARKER_FILE = '.ytdlp-last-check'

let lastFailureUpdateAt = 0
let inflightFailureUpdate: Promise<boolean> | null = null

function markerPath(): string {
	return join(app.getPath('userData'), 'bin', CHECK_MARKER_FILE)
}

function readLastCheckTime(): number {
	try {
		const raw = fs.readFileSync(markerPath(), 'utf-8').trim()
		const value = parseInt(raw, 10)
		return Number.isFinite(value) ? value : 0
	} catch {
		return 0
	}
}

function writeLastCheckTime(): void {
	try {
		const path = markerPath()
		fs.mkdirSync(dirname(path), { recursive: true })
		fs.writeFileSync(path, String(Date.now()))
	} catch (error) {
		console.warn('[ytdlp-updater] could not persist check marker:', error)
	}
}

/** `yt-dlp --version` → "2025.08.11"-style string, or null on any failure. */
export function getLocalYtDlpVersion(binaryPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binaryPath, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout) => {
			resolve(error ? null : stdout.trim() || null)
		})
	})
}

/** Latest release tag from the GitHub API, or null on any failure. */
export async function getLatestYtDlpVersion(): Promise<string | null> {
	try {
		const response = await net.fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FrameFlow' },
			signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS)
		})
		if (!response.ok) return null
		const data: any = await response.json()
		return typeof data?.tag_name === 'string' ? data.tag_name : null
	} catch {
		return null
	}
}

/**
 * Proactive weekly freshness check, run once at startup. Compares the local
 * binary's version against the latest GitHub release and updates when behind.
 * Never throws and never blocks startup — callers fire-and-forget it.
 */
export async function checkYtDlpFreshness(): Promise<void> {
	try {
		if (Date.now() - readLastCheckTime() < STARTUP_CHECK_INTERVAL_MS) return

		// No binary at all is the (user-triggered) install flow, not an update.
		const binaryPath = getYtDlpBinaryPath()
		if (!fs.existsSync(binaryPath)) return

		const local = await getLocalYtDlpVersion(binaryPath)
		if (!local) return
		const latest = await getLatestYtDlpVersion()
		if (!latest) return // offline or rate-limited — try again next launch

		if (isNewerYtDlpVersion(latest, local)) {
			console.log(`[ytdlp-updater] weekly check: ${local} → ${latest}, updating`)
			await dependencyManager.installYtDlp({ reason: 'freshness' })
		} else {
			console.log(`[ytdlp-updater] weekly check: yt-dlp ${local} is up to date`)
		}
		writeLastCheckTime()
	} catch (error) {
		console.warn('[ytdlp-updater] startup freshness check failed:', error)
	}
}

/**
 * Failure-triggered update: installs the latest release so the caller can
 * retry the failed operation. Resolves true when an update was performed
 * (retry is worthwhile) and false when throttled or failed (rethrow the
 * original error). Concurrent failures share one attempt — and one retry
 * verdict — rather than the loser being throttled into a dead retry.
 */
export function updateYtDlpForFailure(): Promise<boolean> {
	if (inflightFailureUpdate) return inflightFailureUpdate
	if (Date.now() - lastFailureUpdateAt < FAILURE_UPDATE_INTERVAL_MS) {
		return Promise.resolve(false)
	}
	lastFailureUpdateAt = Date.now()

	inflightFailureUpdate = (async () => {
		try {
			await dependencyManager.installYtDlp({ reason: 'auto-recovery' })
			writeLastCheckTime() // freshly installed — skip the next weekly check
			return true
		} catch (error) {
			console.error('[ytdlp-updater] failure-triggered update failed:', error)
			return false
		} finally {
			inflightFailureUpdate = null
		}
	})()
	return inflightFailureUpdate
}
