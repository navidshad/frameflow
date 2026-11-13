import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectFaces } from './yunet'
import { embedFace } from './sface'
import { ObjectFollower } from './vittrack'
import type { Frame } from './image'

/**
 * The three model ports against OpenCV's own results on real frames.
 *
 * Needs a folder made by the reference script (raw 960×540 bgr frames
 * 0040.bgr–0060.bgr and ref.json holding OpenCV's answers), so it is skipped
 * anywhere that folder is absent:
 *
 *     FRAMEFLOW_TRACK_REF=/path/to/raw npx vitest run src/main/tracking/portCheck.test.ts
 */
const dir = process.env.FRAMEFLOW_TRACK_REF || ''
const ready = !!dir && existsSync(join(dir, 'ref.json'))
const frame = (i: number): Frame => ({ data: new Uint8Array(readFileSync(join(dir, `${String(i).padStart(4, '0')}.bgr`))), width: 960, height: 540 })

describe.skipIf(!ready)('model ports match OpenCV', () => {
	const ref = ready ? JSON.parse(readFileSync(join(dir, 'ref.json'), 'utf8')) : null

	it('finds the same faces in the same places', async () => {
		const faces = await detectFaces(frame(40))
		expect(faces.length).toBe(ref.faces.length)
		for (const want of ref.faces as number[][]) {
			const got = faces.find((f) => Math.abs(f.x - want[0]) < 3 && Math.abs(f.y - want[1]) < 3)
			expect(got, `face at ${want[0]},${want[1]}`).toBeTruthy()
			expect(Math.abs(got!.w - want[2])).toBeLessThan(3)
			expect(Math.abs(got!.score - want[14])).toBeLessThan(0.03)
		}
	})

	it('embeds a face the way OpenCV does', async () => {
		const sims: number[] = []
		for (let n = 0; n < ref.faces.length; n++) {
			const e = await embedFace(frame(40), (ref.faces[n] as number[]).slice(4, 14))
			sims.push((ref.emb[n] as number[]).reduce((s, v, i) => s + v * e[i], 0))
		}
		console.log('embedding agreement (cosine):', sims.map((s) => s.toFixed(4)).join(' '))
		for (const s of sims) expect(s).toBeGreaterThan(0.98)
	})

	it('follows a box the way OpenCV does', async () => {
		const follower = new ObjectFollower()
		await follower.start(frame(40), { x: 768, y: 176, w: 61, h: 70 })
		let worst = 0
		const t0 = Date.now()
		for (let i = 41; i <= 60; i++) {
			const { box, score } = await follower.step(frame(i))
			const [want, wantScore] = ref.vit[i - 41] as [number[], number]
			worst = Math.max(worst, Math.abs(box.x - want[0]), Math.abs(box.y - want[1]), Math.abs(box.w - want[2]), Math.abs(box.h - want[3]))
			expect(Math.abs(score - wantScore)).toBeLessThan(0.05)
		}
		console.log(`follower: worst box difference ${worst}px, ${((Date.now() - t0) / 20).toFixed(1)} ms/frame`)
		expect(worst).toBeLessThanOrEqual(2)
	})
})
