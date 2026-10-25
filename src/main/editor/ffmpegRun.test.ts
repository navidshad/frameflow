import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ffmpeg from 'fluent-ffmpeg'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { killAllFfmpeg, liveFfmpegCount, regionTimeoutMs, runCommand } from './ffmpegRun'

// Stand-ins for ffmpeg. Each writes its pid next to the output path (its last
// argument), then `exec`s, so the pid is the process the runner must kill.
const SCRIPTS: Record<string, string> = {
	// The hang: alive, silent, 0% CPU.
	asleep: 'exec sleep 600',
	// Busy forever: keeps printing, so only the overall deadline can stop it.
	chatty: 'exec sh -c \'while :; do echo "frame=1 fps=1 time=00:00:00.00" >&2; sleep 0.05; done\'',
	// A normal call: records its arguments and succeeds.
	ok: 'echo "$@" > "$last.args"; exit 0'
}

// fluent-ffmpeg first asks the binary what it supports (`-formats`, `-encoders`);
// answer those at once so only the render call itself behaves as scripted.
const PROBES = 'case "$1" in -formats|-encoders|-codecs|-filters) exit 0;; esac'

const isAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true } catch { return false }
}

describe('runCommand — never a silent hang', () => {
	let dir: string
	const fake = (name: string) => join(dir, `${name}.sh`)
	const commandFor = (name: string) => ffmpeg().setFfmpegPath(fake(name)).input('in.mov')
	const pidOf = async (out: string): Promise<number> => {
		for (let i = 0; i < 100; i++) {
			const text = await fs.readFile(`${out}.pid`, 'utf8').catch(() => '')
			if (text.trim()) return Number(text)
			await new Promise((r) => setTimeout(r, 20))
		}
		throw new Error('the fake ffmpeg never started')
	}

	beforeAll(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'ff-run-'))
		for (const [name, body] of Object.entries(SCRIPTS)) {
			await fs.writeFile(fake(name), `#!/bin/sh\n${PROBES}\nfor last; do :; done\necho $$ > "$last.pid"\n${body}\n`, { mode: 0o755 })
		}
	})

	afterAll(async () => {
		killAllFfmpeg()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it('kills a call that goes quiet, and says which step stalled', async () => {
		const out = join(dir, 'stall.mov')
		const run = runCommand(commandFor('asleep'), out, new AbortController().signal, undefined, {
			stallMs: 300, label: 'region 7 of the export (0.55 s long)'
		})
		const pid = await pidOf(out)
		expect(liveFfmpegCount()).toBe(1)
		await expect(run).rejects.toThrow(/no progress for 0\.3 s while rendering region 7 of the export \(0\.55 s long\) and was stopped/)
		expect(isAlive(pid)).toBe(false)
		expect(liveFfmpegCount()).toBe(0)
	})

	it('kills a call that keeps printing but runs past its deadline', async () => {
		const out = join(dir, 'deadline.mov')
		const started = Date.now()
		const run = runCommand(commandFor('chatty'), out, new AbortController().signal, undefined, {
			timeoutMs: 600, stallMs: 300
		})
		const pid = await pidOf(out)
		await expect(run).rejects.toThrow(/took longer than 0\.6 s and was stopped/)
		// The chatter kept the stall watchdog quiet; the deadline did it.
		expect(Date.now() - started).toBeGreaterThanOrEqual(550)
		expect(isAlive(pid)).toBe(false)
	})

	it('kills the call when the export is aborted', async () => {
		const out = join(dir, 'abort.mov')
		const controller = new AbortController()
		const run = runCommand(commandFor('asleep'), out, controller.signal)
		const pid = await pidOf(out)
		controller.abort()
		await expect(run).rejects.toThrow('aborted')
		expect(isAlive(pid)).toBe(false)
		expect(liveFfmpegCount()).toBe(0)
	})

	it('kills every live call on demand', async () => {
		const outs = [join(dir, 'all-1.mov'), join(dir, 'all-2.mov')]
		const runs = outs.map((out) => runCommand(commandFor('asleep'), out, new AbortController().signal).catch((e) => e))
		const pids = await Promise.all(outs.map(pidOf))
		expect(killAllFfmpeg()).toBe(2)
		await Promise.all(runs)
		expect(pids.map(isAlive)).toEqual([false, false])
	})

	it('runs a normal call to the end, with stdin off', async () => {
		const out = join(dir, 'ok.mov')
		await runCommand(commandFor('ok'), out, new AbortController().signal, undefined, { timeoutMs: 5_000, stallMs: 5_000 })
		expect(await fs.readFile(`${out}.args`, 'utf8')).toContain('-nostdin')
		expect(liveFfmpegCount()).toBe(0)
	})

	it('scales the region deadline with its length', () => {
		expect(regionTimeoutMs(0.55)).toBe(60_000 + 16_500)
		expect(regionTimeoutMs(600)).toBe(60_000 + 18_000_000)
		expect(regionTimeoutMs(-1)).toBe(60_000)
	})
})
