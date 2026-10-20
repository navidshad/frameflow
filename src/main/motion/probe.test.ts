import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build } from 'vite'
import { extractMotionDefinition } from '@shared/motionCode'
import type { MotionProbeInput, MotionProbeResult } from './probe'

/**
 * The determinism probe, REALLY run: pages drawn twice in the hidden window the
 * export uses, inside the real Electron binary (see motionRender.test.ts for
 * the arrangement). Skipped only where Electron cannot open a window at all.
 */

const canOpenWindows = process.platform !== 'linux' || !!process.env.DISPLAY

let dir: string
let harness: string

const page = (seek: string, extra = '') => [
	'<div id="box" style="position:absolute;left:10px;top:10px;width:80px;height:40px;background:#ec4899"></div>',
	`<script>${extra}`,
	'frameflow.define({',
	'  duration: 2,',
	'  settings: [{ key: "x", type: "number", default: 40, min: 0, max: 200, animate: true }],',
	'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 1, flex: true }, { name: "out", duration: 0.5 }],',
	`  seek(t, s) { ${seek} }`,
	'})</script>'
].join('\n')

const input = (html: string): MotionProbeInput => ({
	html,
	definition: extractMotionDefinition(html).definition ?? { duration: 2, settings: [], moments: [] },
	frame: { width: 1280, height: 720 }
})

async function probeInElectron(inputs: MotionProbeInput[]): Promise<MotionProbeResult[]> {
	const file = join(dir, `inputs-${Date.now()}.json`)
	writeFileSync(file, JSON.stringify(inputs))
	const electron = createRequire(import.meta.url)('electron') as string
	const env = { ...process.env }
	delete env.ELECTRON_RUN_AS_NODE
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(electron, [harness, file], { env })
		let out = ''
		let err = ''
		child.stdout.on('data', (d) => { out += d })
		child.stderr.on('data', (d) => { err += d })
		child.on('error', reject)
		child.on('close', (code) => {
			const line = out.split('\n').find((l) => l.startsWith('FRAMEFLOW_RESULT '))
			if (code === 0 && line) resolvePromise(JSON.parse(line.slice('FRAMEFLOW_RESULT '.length)))
			else reject(new Error(`electron exited ${code}\n${err.slice(-2000)}`))
		})
	})
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'frameflow-probe-'))
	if (!canOpenWindows) return
	const outDir = join(dir, 'harness')
	await build({
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: { '@shared': resolve('src/shared') } },
		build: {
			ssr: resolve('src/main/motion/harness/probe-harness.ts'),
			outDir,
			emptyOutDir: true,
			minify: false,
			rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'probe-harness.cjs' } }
		}
	})
	harness = join(outDir, 'probe-harness.cjs')
}, 60_000)

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(!canOpenWindows)('the determinism probe, in real Electron', () => {
	it('passes a pure page, fails one that remembers its last seek, and says what a throwing one threw', async () => {
		const results = await probeInElectron([
			// 1. Pure: position is a function of t and settings.
			input(page('box.style.left = (s.x * frameflow.progress("in", t)) + "px"')),
			// 2. Stateful: each seek nudges the box, so the second visit differs.
			input(page('count++; box.style.left = count + "px"', 'var count = 0;')),
			// 3. Throws while drawing.
			input(page('thisFunctionDoesNotExist(t)')),
			// 4. Throws while loading.
			input(page('box.style.left = "1px"', 'nowhere.to.go = 1;')),
			// 5. The clock is pinned to zero by the runtime, so reading it is still deterministic.
			input(page('box.style.opacity = Date.now() % 2 ? 1 : 0.5')),
			// 6. Never defines itself: nothing to draw.
			input('<div>hello</div>'),
			// 7. A define call the text reader cannot evaluate (a variable duration).
			input(page('box.style.left = "1px"', 'var LEN = 1.25;').replace('duration: 2,', 'duration: LEN,'))
		])

		expect(results[0].determinism).toBe('pass')
		// The page's own report of its definition comes back, for pages whose
		// define call the text reader cannot evaluate.
		expect(results[0].definition!.duration).toBe(2)
		expect(results[0].definition!.settings.map((s) => s.key)).toEqual(['x'])

		expect(results[1].determinism).toBe('fail')
		expect(results[1].differsAt).toBeGreaterThanOrEqual(0)
		expect(results[1].error).toBeUndefined()

		expect(results[2].determinism).toBe('fail')
		expect(results[2].error).toMatch(/thisFunctionDoesNotExist is not defined/)

		expect(results[3].determinism).toBe('fail')
		expect(results[3].error).toMatch(/nowhere is not defined/)

		expect(results[4].determinism).toBe('pass')
		expect(results[5]).toEqual({ determinism: 'skipped' })

		expect(results[6].determinism).toBe('pass')
		expect(results[6].definition!.duration).toBe(1.25)
	}, 90_000)
})
