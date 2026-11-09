import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackSpans } from '@shared/tracking'
import { followObject, scanFaces } from './index'
import { tileImages } from '../editor/exportInspect'

/**
 * The whole pipeline on a real clip: ffmpeg frames, the models, the linking.
 * Skipped unless a clip is named; it writes its check sheets to OUT.
 *
 *     FRAMEFLOW_TRACK_CLIP=/path/clip.mp4 FRAMEFLOW_TRACK_OUT=/tmp/out \
 *     FRAMEFLOW_TRACK_FROM=14 FRAMEFLOW_TRACK_TO=23.2 npx vitest run src/main/tracking/realFootage.test.ts
 */
const clip = process.env.FRAMEFLOW_TRACK_CLIP || ''
const out = process.env.FRAMEFLOW_TRACK_OUT || ''
const from = Number(process.env.FRAMEFLOW_TRACK_FROM || 0)
const to = Number(process.env.FRAMEFLOW_TRACK_TO || 10)
const ready = !!clip && existsSync(clip) && !!out
const spans = (t: { samples: { t: number }[]; fps: number }) =>
	trackSpans(t.samples as never, t.fps).map((s) => `${s.from.toFixed(2)}–${s.to.toFixed(2)}`).join(' ')

async function sheet(name: string, tiles: { ppm: Buffer; t: number }[], labels: string[]) {
	mkdirSync(out, { recursive: true })
	const files = tiles.map((tile, i) => {
		const file = join(out, `${name}-${i}.ppm`)
		writeFileSync(file, tile.ppm)
		return file
	})
	const made = await tileImages(files, labels, { columns: Math.min(6, files.length), tileWidth: 320 })
	writeFileSync(join(out, `${name}.jpg`), made.jpeg)
}

describe.skipIf(!ready)('tracking on a real clip', () => {
	it('finds the people', async () => {
		const t0 = Date.now()
		const scan = await scanFaces(clip, 'asset', { fromSec: from, toSec: to })
		const ms = Date.now() - t0
		console.log(`faces: ${scan.frames} frames in ${(ms / 1000).toFixed(1)} s (${(ms / scan.frames).toFixed(1)} ms/frame), ${scan.tracks.length} people`)
		for (const track of scan.tracks) {
			const filled = track.samples.filter((s) => s.filled).length
			const bridged = track.samples.filter((s) => s.bridged).length
			console.log(`  ${track.name}: ${track.samples.length} samples (${filled} filled, ${bridged} bridged) @${track.fps} fps  ${spans(track)}`)
		}
		await sheet('people', scan.tiles, scan.tracks.map((t) => t.name))
		writeFileSync(join(out, 'tracks.json'), JSON.stringify(scan.tracks))
		expect(scan.tracks.length).toBeGreaterThan(0)
	}, 600_000)

	it('follows a box both ways', async () => {
		const box = (process.env.FRAMEFLOW_TRACK_BOX || '0.04,0,0.3,0.39').split(',').map(Number)
		const at = Number(process.env.FRAMEFLOW_TRACK_AT || from + 1.6)
		const t0 = Date.now()
		const { track, tiles } = await followObject(clip, 'asset', {
			atSec: at, box: { x: box[0], y: box[1], w: box[2], h: box[3] }, direction: 'both', fromSec: from, toSec: to, name: 'thing', shape: 'box'
		})
		const ms = Date.now() - t0
		console.log(`object: ${track.samples.length} samples in ${(ms / 1000).toFixed(1)} s, ended ${JSON.stringify(track.ended)}  ${spans(track)}`)
		await sheet('object', tiles, tiles.map((t) => t.t.toFixed(2)))
		expect(track.samples.length).toBeGreaterThan(1)
	}, 600_000)
})
