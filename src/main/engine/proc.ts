import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import os from 'node:os'

/**
 * Finding and running the user's CLIs. No Electron, so the tests that really
 * spawn the CLI use exactly this.
 *
 * A GUI app on macOS starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which
 * holds none of them. So the search adds the login shell's PATH and the
 * places these CLIs install themselves.
 */

const isWin = process.platform === 'win32'

let loginPath: Promise<string> | null = null

/** The PATH a login shell would have. Asked once, with a short timeout. */
export function loginShellPath(): Promise<string> {
	if (isWin) return Promise.resolve('')
	if (!loginPath) {
		loginPath = new Promise((resolve) => {
			const shell = process.env.SHELL || '/bin/zsh'
			execFile(shell, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 5_000, encoding: 'utf-8' }, (error, stdout) => {
				resolve(error ? '' : String(stdout).trim().split('\n').pop() || '')
			})
		})
	}
	return loginPath
}

function extraDirs(): string[] {
	const home = os.homedir()
	const dirs = [
		'/opt/homebrew/bin', '/usr/local/bin',
		join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.claude', 'local'),
		join(home, '.bun', 'bin'), join(home, '.volta', 'bin')
	]
	if (isWin && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
	// nvm: every installed node's bin, newest first.
	try {
		const versions = join(home, '.nvm', 'versions', 'node')
		for (const v of readdirSync(versions).sort().reverse()) dirs.push(join(versions, v, 'bin'))
	} catch { /* no nvm */ }
	return dirs
}

/** PATH for searching and for the child (a node-based CLI needs `node` on it). */
export async function searchPath(): Promise<string> {
	const parts = [process.env.PATH || '', await loginShellPath(), extraDirs().join(delimiter)]
		.join(delimiter).split(delimiter).filter(Boolean)
	return [...new Set(parts)].join(delimiter)
}

const executable = (path: string): boolean => {
	try {
		accessSync(path, isWin ? constants.F_OK : constants.X_OK)
		return true
	} catch {
		return false
	}
}

export function findBinary(bin: string, path: string): string | null {
	const names = isWin ? [`${bin}.cmd`, `${bin}.exe`, `${bin}.bat`, bin] : [bin]
	for (const dir of path.split(delimiter)) {
		for (const name of names) {
			const candidate = join(dir, name)
			if (executable(candidate)) return candidate
		}
	}
	return null
}

export interface RunResult { stdout: string; stderr: string; code: number | null }

/** A short command (`--version`, `auth status`). Never throws. */
export function runQuick(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(file, args, { env, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, shell: isWin }, (error: any, stdout, stderr) => {
			resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 })
		})
	})
}

/**
 * Spawns in its own process group so the whole tree — a CLI's MCP client, its
 * helpers — can be killed together.
 */
export function spawnTree(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
	return spawn(file, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: !isWin,
		windowsHide: true,
		shell: isWin && /\.(cmd|bat)$/i.test(file)
	})
}

/**
 * SIGTERM to the group, then SIGKILL. The group is signalled even when the
 * leader has exited, so helpers it left behind go too.
 */
export function killTree(child: ChildProcess, graceMs = 3_000): void {
	if (!child.pid) return
	const pid = child.pid
	if (isWin) {
		if (child.exitCode !== null) return
		spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
		return
	}
	const signal = (sig: NodeJS.Signals) => {
		try { process.kill(-pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
	}
	signal('SIGTERM')
	const timer = setTimeout(() => signal('SIGKILL'), graceMs)
	timer.unref()
}
