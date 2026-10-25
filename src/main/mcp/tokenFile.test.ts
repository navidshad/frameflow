import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestedTokenFile, writeTokenFile, TOKEN_FILE_ENV } from './tokenFile'

describe('agent token file', () => {
	let dir: string
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-token-')) })
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('is off unless the launcher asks for it', () => {
		expect(requestedTokenFile(['electron', 'out/main/index.js', '--user-data-dir=/x'], {})).toBeNull()
		expect(requestedTokenFile(['app', '--agent-token-file'], {})).toBeNull()
		expect(requestedTokenFile(['app', '--agent-token-file', '--other'], {})).toBeNull()
		expect(requestedTokenFile(['app'], { [TOKEN_FILE_ENV]: '  ' })).toBeNull()
	})

	it('takes the flag (either form) over the environment, as an absolute path', () => {
		expect(requestedTokenFile(['app', '--agent-token-file', 'tok'], { [TOKEN_FILE_ENV]: '/env/tok' }, '/work')).toBe('/work/tok')
		expect(requestedTokenFile(['app', '--agent-token-file=/abs/tok'], {})).toBe('/abs/tok')
		expect(requestedTokenFile(['app'], { [TOKEN_FILE_ENV]: '/env/tok' })).toBe('/env/tok')
	})

	it('writes the token readable by its owner only, and replaces it on a new token', () => {
		const path = join(dir, 'agent.token')
		writeTokenFile(path, 'ff_one')
		expect(readFileSync(path, 'utf8')).toBe('ff_one\n')
		expect(statSync(path).mode & 0o777).toBe(0o600)

		writeFileSync(path, 'old', { mode: 0o644 })
		writeTokenFile(path, 'ff_two')
		expect(readFileSync(path, 'utf8').trim()).toBe('ff_two')
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(readdirSync(dir)).toEqual(['agent.token']) // no temp left behind
	})

	it('replaces a symlink at the target instead of writing through it', () => {
		const victim = join(dir, 'victim')
		writeFileSync(victim, 'keep me')
		const path = join(dir, 'agent.token')
		symlinkSync(victim, path)
		writeTokenFile(path, 'ff_three')
		expect(readFileSync(victim, 'utf8')).toBe('keep me')
		expect(lstatSync(path).isSymbolicLink()).toBe(false)
		expect(readFileSync(path, 'utf8').trim()).toBe('ff_three')
	})

	it('fails without leaving anything when the folder is missing', () => {
		expect(() => writeTokenFile(join(dir, 'nope', 'agent.token'), 'ff_x')).toThrow()
		expect(readdirSync(dir)).toEqual([])
	})
})
