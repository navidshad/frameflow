import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
	displayPath, ENGINES, geminiAuthType, parseClaudeAuth, parseCodexLogin, parseCodexModels,
	parseVersion, type CliEngineId, type EngineDetection
} from '@shared/engines'
import { findBinary, runQuick, searchPath } from './proc'

/**
 * Is each CLI installed, which version, and is it signed in — as far as the
 * CLI itself can say. Claude Code and Codex have status commands; Gemini CLI
 * does not, so its settings file is read instead.
 *
 * A failure a run discovered (Gemini CLI's personal-account refusal) is
 * remembered here, so the Settings card shows it instead of "Found".
 */

const runFailures = new Map<CliEngineId, string>()

export function recordRunFailure(id: CliEngineId, note: string | null): void {
	if (note) runFailures.set(id, note)
	else runFailures.delete(id)
}

const readText = (path: string): string | undefined => {
	try { return readFileSync(path, 'utf-8') } catch { return undefined }
}

export interface Located { id: CliEngineId; path: string; env: NodeJS.ProcessEnv }

/** Where a CLI is, and the env to run it with (PATH widened). */
export async function locate(id: CliEngineId): Promise<Located | null> {
	const PATH = await searchPath()
	const path = findBinary(ENGINES[id].bin!, PATH)
	return path ? { id, path, env: { ...process.env, PATH } } : null
}

export async function detectCli(id: CliEngineId): Promise<EngineDetection> {
	const found = await locate(id)
	if (!found) {
		return { id, status: 'missing', note: `${ENGINES[id].label} is not installed, or not on your PATH.` }
	}
	const home = os.homedir()
	const base = { id, path: found.path, displayPath: displayPath(found.path, home) }
	const version = parseVersion((await runQuick(found.path, ['--version'], found.env)).stdout)
	const failure = runFailures.get(id)
	const withFailure = (d: EngineDetection): EngineDetection => (failure ? { ...d, status: 'unusable', note: failure } : d)

	if (id === 'claude-code') {
		const auth = await runQuick(found.path, ['auth', 'status'], found.env)
		const signedIn = parseClaudeAuth(auth.stdout)
		return withFailure({
			...base, version,
			status: signedIn === true ? 'signed-in' : signedIn === false ? 'signed-out' : 'found',
			note: signedIn === false ? 'Run `claude` in a terminal and sign in.' : undefined
		})
	}
	if (id === 'codex') {
		const [login, models] = await Promise.all([
			runQuick(found.path, ['login', 'status'], found.env),
			runQuick(found.path, ['debug', 'models'], found.env, 15_000)
		])
		const signedIn = parseCodexLogin(`${login.stdout}\n${login.stderr}`, login.code)
		return withFailure({
			...base, version,
			status: signedIn === true ? 'signed-in' : signedIn === false ? 'signed-out' : 'found',
			note: signedIn === false ? 'Run `codex login` in a terminal.' : undefined,
			models: parseCodexModels(models.stdout)
		})
	}
	// Gemini CLI: no status command.
	const authType = geminiAuthType(readText(join(home, '.gemini', 'settings.json')), process.env)
	return withFailure({
		...base, version,
		status: authType ? 'found' : 'signed-out',
		note: authType ? undefined : 'Run `gemini` in a terminal once to sign in.'
	})
}
