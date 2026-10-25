import { describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { syncRecordings } from './sync'

/**
 * Opt-in: syncs a real shoot. Point FF_MULTICAM_FOOTAGE at a folder of camera
 * files and list them, reference first, in FF_MULTICAM_FILES (comma separated):
 *
 *   FF_MULTICAM_FOOTAGE=footage FF_MULTICAM_FILES=Cam02/IMG_4913.MOV,Cam01/DJI_…MP4 \
 *     npx vitest run src/main/multicam/realFootage.test.ts
 *
 * Skipped everywhere else: the files are tens of gigabytes and never in git.
 */
const dir = process.env.FF_MULTICAM_FOOTAGE
const files = (process.env.FF_MULTICAM_FILES ?? '').split(',').filter(Boolean)
const ready = !!dir && files.length >= 2 && files.every((f) => existsSync(join(dir, f)))

describe.skipIf(!ready)('a real shoot', () => {
	it('syncs every file against the first', async () => {
		const started = Date.now()
		const members = await syncRecordings(
			files.map((f) => ({ assetId: f, path: join(dir!, f) })),
			{ onProgress: (fraction, label) => console.log(`${Math.round(fraction * 100)}% ${label} (${((Date.now() - started) / 1000).toFixed(0)} s)`) }
		)
		for (const m of members) {
			console.log(JSON.stringify({
				file: m.assetId, offsetSec: Math.round(m.offset * 10000) / 10000, ppm: m.sync.driftPpm,
				confidence: m.sync.confidence, windows: m.sync.windows, residualMs: m.sync.residualSec !== undefined ? Math.round(m.sync.residualSec * 1000) : undefined,
				snrDb: m.quality ? Math.round(m.quality.snrDb * 10) / 10 : null, clipped: m.quality?.clipped
			}))
		}
		console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`)
		expect(members).toHaveLength(files.length)
	}, 1_800_000)
})
