import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build } from 'vite'
import { DEFAULT_AGENT_PERMISSIONS } from '@shared/agent'
import type { MotionProbeInput, MotionProbeResult } from '../motion/probe'
import { AgentServer } from './server'
import { FakeEditor, TOKEN } from './fakeEditor'

/**
 * Pages an agent writes are checked before they replace anything — with the
 * REAL probe. The server and editor are the production code (only the editor's
 * document is in memory); every page is drawn twice in a real hidden Electron
 * window, so a page that lints clean but draws differently on a second visit
 * is rejected by the thing that would reject it in the app.
 *
 * Skipped only where Electron cannot open a window (Linux with no display).
 */

const canOpenWindows = process.platform !== 'linux' || !!process.env.DISPLAY

let dir: string
let harness: string

async function probeInElectron(input: MotionProbeInput): Promise<MotionProbeResult> {
	const file = join(dir, `input-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
	writeFileSync(file, JSON.stringify([input]))
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
			if (code === 0 && line) resolvePromise(JSON.parse(line.slice('FRAMEFLOW_RESULT '.length))[0])
			else reject(new Error(`electron exited ${code}\n${err.slice(-1500)}`))
		})
	})
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'frameflow-vet-'))
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

const page = (seek: string, extra = '') => [
	'<div id="box" style="position:absolute;left:10px;top:10px;width:80px;height:40px;background:#ec4899"></div>',
	`<script>${extra}`,
	'frameflow.define({',
	'  duration: 3,',
	'  settings: [{ key: "x", type: "number", default: 40, min: 0, max: 200 }],',
	'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 2, flex: true }, { name: "out", duration: 0.5 }],',
	`  seek(t, s) { ${seek} }`,
	'})</script>'
].join('\n')

const GOOD = page('box.style.left = (ease(clamp(t / 2)) * s.x) + "px"')
// Clean as far as the text goes — no clock, no timer, no random — but each seek
// nudges the box, so the second visit to a frame draws differently.
const STATEFUL = page('count++; box.style.left = count + "px"', 'var count = 0;')
const THROWS = page('thisFunctionDoesNotExist(t)')

// A page whose define() says `duration: SPEC.duration`: read from the text it
// is the 3 s default; run, it is 9 s. It draws the same twice up to t = 3 and
// differently after — only a probe at the RUN-TIME duration sees that.
const SPEC_DURATION = [
	'<div id="box" style="position:absolute;left:10px;top:10px;width:80px;height:40px;background:#ec4899"></div>',
	'<script>var SPEC = { duration: 9 }; var count = 0;',
	'frameflow.define({',
	'  duration: SPEC.duration,',
	'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: SPEC.duration - 1, flex: true }, { name: "out", duration: 0.5 }],',
	'  seek(t) { if (t > 3) count++; box.style.left = (t > 3 ? 100 + count * 7 : 40) + "px" }',
	'})</script>'
].join('\n')

// The vlog's second probe failure: a page that sizes a card from the label it
// has NOT yet updated for this t, so a revisit reads the previous seek's layout.
const MEASURES_FIRST = [
	'<div id="card" style="position:absolute;left:20px;top:20px;height:60px;background:#1d1a17"></div>',
	'<span id="label" style="position:absolute;left:20px;top:100px;font:32px sans-serif;white-space:nowrap"></span>',
	'<script>frameflow.define({',
	'  duration: 4,',
	'  seek(t) { card.style.width = label.offsetWidth + "px"; label.textContent = t < 2 ? "Gym" : "Gym inside the hostel" }',
	'})</script>'
].join('\n')

// The real page from the vlog (B Yekan stripped), with the define() the agent
// first wrote: `duration: SPEC.duration`, which runs 40.6 s.
const GYM = readFileSync(resolve('src/main/motion/fixtures/vlog-21-gym.html'), 'utf8')

describe.skipIf(!canOpenWindows)('pages an agent writes, checked with the real probe', () => {
	let editor: FakeEditor
	let server: AgentServer
	let url: URL
	const clients: Client[] = []

	beforeEach(async () => {
		editor = new FakeEditor()
		server = new AgentServer({
			bridge: editor, token: () => TOKEN, permissions: () => ({ ...DEFAULT_AGENT_PERMISSIONS }), version: 'test',
			probeMotion: probeInElectron
		})
		url = new URL(`http://127.0.0.1:${await server.start(0)}/mcp`)
	})
	afterEach(async () => {
		await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
		await server.stop()
	})

	const connect = async () => {
		const client = new Client({ name: 'claude-code', version: '2.1.0' })
		await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
		clients.push(client)
		return client
	}
	const ops = async (client: Client, args: Record<string, unknown>): Promise<any> =>
		await client.callTool({ name: 'apply_ops', arguments: args })

	it('applies a page that draws the same twice, and rejects one that does not — leaving the earlier page in place', async () => {
		const client = await connect()

		const added = await ops(client, { addMotion: [{ template: 'custom', atSec: 4, html: GOOD }] })
		expect(added.isError).toBeFalsy()
		const layer = editor.doc.timeline.find((i) => i.motion)!
		expect(layer.motion!.html).toBe(GOOD)
		const commits = editor.commits.length
		const before = JSON.stringify(editor.doc.timeline)

		const rejected = await ops(client, { rationale: 'Count', updateMotion: [{ id: layer.id, html: STATEFUL }] })
		expect(rejected.isError).toBe(true)
		const message: string = rejected.content[0].text
		expect(message).toContain(`updateMotion ${layer.id} rejected, the layer keeps its previous page`)
		expect(message).toMatch(/drawing the same frame twice gave different pixels at t = \d\.\d\ds/)
		expect(message).toMatch(/depends on state left by an earlier call/)
		expect(rejected.content.some((c: any) => c.type === 'image')).toBe(true)

		// The agent's edit never reached the document.
		expect(editor.commits).toHaveLength(commits)
		expect(JSON.stringify(editor.doc.timeline)).toBe(before)
		expect(editor.doc.timeline.find((i) => i.id === layer.id)!.motion!.html).toBe(GOOD)
	}, 120_000)

	it('returns where and how much a frame differs, with an image of both renders', async () => {
		const client = await connect()
		const rejected = await ops(client, { addMotion: [{ template: 'custom', atSec: 4, html: STATEFUL }] })
		expect(rejected.isError).toBe(true)
		const text: string = rejected.content[0].text
		expect(text).toMatch(/\d+ pixels differ \([^)]*of the frame, probed at 1\/3 size\), in a box \d+×\d+ px at x \d+, y \d+ \(sequence pixels\)/)
		expect(text).toMatch(/the largest change is \d+\/255/)
		const image = rejected.content.find((c: any) => c.type === 'image')
		expect(image?.mimeType).toBe('image/png')
		expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
	}, 120_000)

	it('blames layout measured before it is updated, for the page that does that', async () => {
		const client = await connect()
		const rejected = await ops(client, { addMotion: [{ template: 'custom', atSec: 4, html: MEASURES_FIRST }] })
		expect(rejected.isError).toBe(true)
		expect(rejected.content[0].text).toMatch(/This looks like state: .*layout MEASURED before it is UPDATED/)
		expect(rejected.content.some((c: any) => c.type === 'image')).toBe(true)
	}, 120_000)

	it('probes at the duration the page reports when it runs, not the 3 s its text reads as', async () => {
		const client = await connect()
		const rejected = await ops(client, { addMotion: [{ template: 'custom', atSec: 4, html: SPEC_DURATION }] })
		expect(rejected.isError).toBe(true)
		const at = Number(/at t = (\d+\.\d+)s/.exec(rejected.content[0].text)![1])
		expect(at).toBeGreaterThan(3)
	}, 120_000)

	it('keeps a layer\'s length when its page’s duration is an expression (the vlog’s 21-gym card)', async () => {
		const client = await connect()
		const added = await ops(client, { addMotion: [{ template: 'custom', atSec: 2, html: GYM, label: 'Gym' }] })
		expect(added.isError).toBeFalsy()
		const layer = editor.doc.timeline.find((i) => i.motion)!
		// Read by running it: 40.6 s, not the 3 s default the text reads as.
		expect(layer.duration).toBeCloseTo(40.6, 3)
		const body = JSON.parse(added.content[0].text)
		expect(body.notes.join(' ')).toMatch(/It read them by running the page: 40\.6 s/)

		const restyled = GYM.replace("default: '#FF6A3D'", "default: '#3D8BFF'")
		const updated = await ops(client, { rationale: 'Restyle', updateMotion: [{ id: layer.id, html: restyled }] })
		expect(updated.isError).toBeFalsy()
		expect(editor.doc.timeline.find((i) => i.id === layer.id)!.duration).toBeCloseTo(40.6, 3)
	}, 120_000)

	it('moves an overlapping retime to another motion track and says so; nothing else moves', async () => {
		const client = await connect()
		await ops(client, { addMotion: [{ template: 'custom', atSec: 1, html: GOOD, label: 'A' }, { template: 'custom', atSec: 5, html: GOOD, label: 'B' }] })
		const a = editor.doc.timeline.find((i) => i.label === 'A')!
		const b = editor.doc.timeline.find((i) => i.label === 'B')!
		expect(a.trackId).toBe(b.trackId)
		const result = await ops(client, { rationale: 'Retime', updateMotion: [{ id: a.id, atSec: 4 }] })
		const body = JSON.parse(result.content[0].text)
		expect(body.applied.updated).toBe(1)
		expect(body.notes.join(' ')).toMatch(/"A" moved to M2: it would overlap "B" on M1/)
		const after = editor.doc.timeline
		expect(after.find((i) => i.id === b.id)!.timelineStart).toBe(5)
		expect(after.find((i) => i.id === a.id)!).toMatchObject({ timelineStart: 4 })
		expect(after.find((i) => i.id === a.id)!.trackId).not.toBe(b.trackId)
	}, 120_000)

	it('says what a page that throws threw, and adds nothing', async () => {
		const client = await connect()
		const rejected = await ops(client, { addMotion: [{ template: 'custom', atSec: 4, html: THROWS }] })
		expect(rejected.isError).toBe(true)
		expect(rejected.content[0].text).toMatch(/addMotion\[0\] \(custom page\) rejected, nothing was added: the page throws when it runs: .*thisFunctionDoesNotExist is not defined/)
		expect(editor.doc.timeline.some((i) => i.motion)).toBe(false)
	}, 120_000)

	it('applies a good page alongside a rejected one in the same call', async () => {
		const client = await connect()
		const result = await ops(client, { addMotion: [{ template: 'custom', atSec: 1, html: STATEFUL }, { template: 'custom', atSec: 6, html: GOOD }] })
		expect(result.isError).toBeFalsy()
		const body = JSON.parse(result.content.find((c: any) => c.type === 'text').text)
		expect(body.droppedOps.join(' ')).toMatch(/addMotion\[0\] \(custom page\) rejected/)
		expect(editor.doc.timeline.filter((i) => i.motion).map((i) => i.motion!.html)).toEqual([GOOD])
	}, 120_000)
})
