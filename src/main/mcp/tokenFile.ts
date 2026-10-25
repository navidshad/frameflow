import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * The agent token for scripts, without the clipboard.
 *
 * The token is encrypted on disk, so a headless run (a test harness, a script
 * that launches FrameFlow on a scratch profile) had no way to read it. Whoever
 * launches FrameFlow can ask for it in a file:
 *
 *   FrameFlow --agent-token-file /path/to/token
 *   FRAMEFLOW_AGENT_TOKEN_FILE=/path/to/token FrameFlow
 *
 * Off unless asked for. The file is created owner-only (0600), replaced
 * atomically, and rewritten when the user makes a new token. The token itself
 * is never logged. It does not turn agent access on: that stays the user's
 * switch in Settings.
 */

export const TOKEN_FILE_FLAG = '--agent-token-file'
export const TOKEN_FILE_ENV = 'FRAMEFLOW_AGENT_TOKEN_FILE'

/** The path asked for on the command line (wins) or in the environment, absolute; null when none. */
export function requestedTokenFile(argv: string[], env: Record<string, string | undefined>, cwd = process.cwd()): string | null {
	let raw: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === TOKEN_FILE_FLAG) {
			raw = argv[i + 1]
			break
		}
		if (arg.startsWith(`${TOKEN_FILE_FLAG}=`)) {
			raw = arg.slice(TOKEN_FILE_FLAG.length + 1)
			break
		}
	}
	if (raw === undefined) raw = env[TOKEN_FILE_ENV]
	raw = raw?.trim()
	if (!raw || raw.startsWith('--')) return null
	return resolve(cwd, raw)
}

/**
 * Writes the token to `path`, readable by its owner only. The temp file is
 * created exclusively with mode 0600 and renamed over the target, so the token
 * is never briefly world-readable and a symlink at the target is replaced, not
 * followed.
 */
export function writeTokenFile(path: string, token: string): void {
	const dir = dirname(path)
	if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: 'wx' })
		chmodSync(temp, 0o600) // the umask can only narrow the mode, but be explicit
		renameSync(temp, path)
	} catch (error) {
		rmSync(temp, { force: true })
		throw error
	}
}
