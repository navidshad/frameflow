import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile, spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { build } from 'vite'
import type { TimelineItem } from '@shared/types'
import { normaliseDefinition, type MotionKit, type MotionSpec } from '@shared/motion'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import type { MotionJob } from './index'

/**
 * Kits and the bundled Persian face, REALLY drawn: the production
 * `renderMotionClip` in the real Electron binary (see motionRender.test.ts for
 * why it is a spawned harness), compared frame by frame.
 *
 * Skipped only where Electron cannot open a window (Linux with no display).
 */

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()
const canOpenWindows = process.platform !== 'linux' || !!process.env.DISPLAY
const frame = { width: 480, height: 270, fps: 10 }

let dir: string
let harness: string

const clip = (id: string, spec: MotionSpec, duration = 0.3): TimelineItem => ({
	id, trackId: 'm', sourceAssetId: '', timelineStart: 0, in: 0, out: duration, speed: 1,
	preservePitch: true, duration, motion: spec
})
const custom = (html: string, kit?: string): MotionSpec => {
	const definition = normaliseDefinition({ duration: 0.3 })
	return { html, definition, passed: { html, definition, verified: true }, ...(kit ? { kit } : {}) }
}
const textPage = (family: string, text: string) =>
	`<div style="position:absolute;left:20px;top:60px;font:700 64px ${family};color:#fff;direction:rtl">${text}</div>` +
	'<script>frameflow.define({ duration: 0.3, settings: [], moments: [], seek() {} })</script>'

async function render(jobs: MotionJob[]): Promise<void> {
	const jobsFile = join(dir, `jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
	writeFileSync(jobsFile, JSON.stringify(jobs))
	const electron = createRequire(import.meta.url)('electron') as string
	const env = { ...process.env }
	delete env.ELECTRON_RUN_AS_NODE
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(electron, [harness, jobsFile], { env })
		let out = ''
		let err = ''
		child.stdout.on('data', (d) => { out += d })
		child.stderr.on('data', (d) => { err += d })
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0 && out.includes('FRAMEFLOW_RESULT ')) resolvePromise()
			else reject(new Error(`electron exited ${code}\n${err.slice(-2000)}`))
		})
	})
}

const job = (name: string, item: TimelineItem, kits?: MotionKit[]): MotionJob =>
	({ item, frame, outputPath: join(dir, `${name}.mov`), kits })

/** Per-frame decoded hashes: identical lists mean identical pictures. */
const frameHashes = async (name: string): Promise<string[]> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-i', join(dir, `${name}.mov`), '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 1 << 24 })
	return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim())
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'frameflow-kit-'))
	if (!canOpenWindows) return
	const outDir = join(dir, 'harness')
	await build({
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: { '@shared': resolve('src/shared') } },
		build: {
			ssr: resolve('src/main/motion/harness/render-harness.ts'),
			outDir,
			emptyOutDir: true,
			minify: false,
			rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'render-harness.cjs' } }
		}
	})
	harness = join(outDir, 'render-harness.cjs')
}, 60_000)

afterAll(() => {
	if (dir && !process.env.KEEP_MOTION_TEST) rmSync(dir, { recursive: true, force: true })
	else if (dir) console.log('kept', dir)
})

describe.skipIf(!canOpenWindows)('the bundled Persian face, drawn', () => {
	// One word: the letters are what is compared. (A space is the family's own —
	// Inter's inside an Inter stack — so a phrase legitimately spaces differently.)
	const persian = 'ارمنستان۱۴۰۳'
	beforeAll(async () => {
		await render([
			job('fa-inter', clip('a', custom(textPage('Inter, sans-serif', persian)))),
			job('fa-outfit-inter', clip('b', custom(textPage("Outfit, Inter, sans-serif", persian)))),
			job('fa-vazirmatn', clip('c', custom(textPage('Vazirmatn', persian)))),
			job('fa-system', clip('d', custom(textPage('serif', persian)))),
			job('phrase-serif', clip('g', custom(textPage('Vazirmatn, serif', 'سفر به «ارمنستان»، ۱۴۰۳…')))),
			job('phrase-mono', clip('h', custom(textPage('Vazirmatn, monospace', 'سفر به «ارمنستان»، ۱۴۰۳…')))),
			job('en-inter', clip('e', custom(textPage('Inter', 'Armenia')))),
			job('en-vazirmatn', clip('f', custom(textPage('Vazirmatn, serif', 'Armenia'))))
		])
	}, 120_000)

	it('draws Persian in an Inter (or Outfit, Inter) stack in Vazirmatn', async () => {
		const vazir = await frameHashes('fa-vazirmatn')
		expect(await frameHashes('fa-inter')).toEqual(vazir)
		expect(await frameHashes('fa-outfit-inter')).toEqual(vazir)
		// …and not in whatever the system would have used.
		expect(await frameHashes('fa-system')).not.toEqual(vazir)
	})

	it('spaces and punctuates a Vazirmatn phrase itself, whatever the stack falls back to', async () => {
		expect(await frameHashes('phrase-mono')).toEqual(await frameHashes('phrase-serif'))
	})

	it('leaves Latin to Inter: Vazirmatn carries no Latin', async () => {
		expect(await frameHashes('en-vazirmatn')).not.toEqual(await frameHashes('en-inter'))
	})
})

describe.skipIf(!canOpenWindows)('a page built on a kit, drawn', () => {
	const css = '.card{position:absolute;left:30px;top:40px;padding:18px 28px;border-radius:24px;background:#FFF7EC;color:#1D1A17;font:700 44px Outfit, Inter, sans-serif}'
	const js = 'window.nomad = { place: function (el, t) { el.style.transform = "translateX(" + Math.round(200 * t) + "px)"; el.style.opacity = String(Math.min(1, 0.4 + t)) } }'
	const body = '<div class="card" id="c">مقصد اول · Yerevan</div>'
	const define = '<script>const c = document.getElementById("c")\nframeflow.define({ duration: 0.3, settings: [], moments: [], seek(t) { nomad.place(c, t) } })</script>'
	const kit: MotionKit = { id: 'nomad', css, js }
	const restyled: MotionKit = { ...kit, css: css.replace('#FFF7EC', '#1E8A5A') }

	beforeAll(async () => {
		await render([
			job('inline', clip('a', custom(`<style>${css}</style><script>${js}</script>${body}${define}`))),
			job('kit', clip('b', custom(body + define, 'nomad')), [kit]),
			job('kit-restyled', clip('c', custom(body + define, 'nomad')), [restyled])
		])
	}, 120_000)

	it('draws exactly what the same page with the kit pasted in draws', async () => {
		const inline = await frameHashes('inline')
		expect(inline.length).toBe(3)
		expect(new Set(inline).size).toBe(3) // it moves: the frames really differ
		expect(await frameHashes('kit')).toEqual(inline)
	})

	it('redraws with the kit when the kit changes', async () => {
		const before = await frameHashes('kit')
		const after = await frameHashes('kit-restyled')
		for (let k = 0; k < before.length; k++) expect(after[k]).not.toBe(before[k])
	})
})
