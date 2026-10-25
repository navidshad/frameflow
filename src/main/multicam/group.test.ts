import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '@shared/types'
import { anglesOf, soundCameraOf } from '@shared/multicam'
import { buildCameraGroup, type SyncRunner } from './group'

const file = (id: string, path: string, duration: number, recordedAt: number, kind: 'video' | 'audio' = 'video'): MediaAsset => ({
	id, kind, name: path.split('/').pop()!, originalPath: path,
	metadata: { duration, width: 3840, height: 2160, fps: 30, size: 1, codec: 'hevc', format: 'mov', hasAudio: true, recordedAt },
	preprocessing: {}, clips: [], createdAt: 0
})
const at = (h: number, m: number, s: number) => Date.UTC(2026, 6, 17, h, m, s)

// The Gap-time shoot: an iPhone, and a DJI that split its recording into three files.
const media = [
	file('dji1', '/Gap-time/Cam01/DJI_20260717171155_0022_D.MP4', 2604.949, at(15, 11, 55)),
	file('dji2', '/Gap-time/Cam01/DJI_20260717175520_0023_D.MP4', 2610.304, at(15, 55, 22)),
	file('dji3', '/Gap-time/Cam01/DJI_20260717183851_0024_D.MP4', 321.488, at(16, 38, 52)),
	file('iphone', '/Gap-time/Cam02/IMG_4913.MOV', 5475.743, at(15, 4, 22))
]

/** A sync that "measures" what the real one measured, except it cannot place `unplaceable`. */
const fakeSync = (unplaceable?: string): SyncRunner => async (inputs) => {
	const measured: Record<string, [number, number, number]> = {
		iphone: [0, 1, 19], dji1: [-50.1826, 1.0000052, 22.2], dji2: [2554.7827, 1.0000063, 25.2], dji3: [5165.1101, 0.9999794, 21.7]
	}
	return inputs.map((input, i) => {
		const [offset, rate, snrDb] = measured[input.assetId]
		const failed = input.assetId === unplaceable
		return {
			assetId: input.assetId,
			offset: failed ? 0 : offset,
			rate: failed ? 1 : rate,
			sync: i === 0
				? { method: 'reference' as const, confidence: 'strong' as const, driftPpm: 0 }
				: { method: failed ? 'manual' as const : 'audio' as const, confidence: failed ? 'failed' as const : 'strong' as const, driftPpm: 0 },
			quality: { levelDb: -12, noiseDb: -12 - snrDb, snrDb, clipped: input.assetId === 'dji2' ? 0.0012 : 0 }
		}
	})
}

describe('buildCameraGroup', () => {
	it('measures against the longest file and names cameras by their folders', async () => {
		let order: string[] = []
		const spy: SyncRunner = async (inputs, opts) => { order = inputs.map((i) => i.assetId); return fakeSync()(inputs, opts) }
		const { group } = await buildCameraGroup(media, ['dji1', 'dji2', 'dji3', 'iphone'], { sync: spy })
		expect(order[0]).toBe('iphone')
		expect(anglesOf(group, media).map((c) => [c.name, c.members.map((m) => m.assetId)])).toEqual([
			['Cam01', ['dji1', 'dji2', 'dji3']], ['Cam02', ['iphone']]
		])
		expect(group.name).toBe('Gap-time')
	})

	it('picks the cleanest camera for the main sound, over all its files', async () => {
		// As measured on the real shoot: the DJI's voices stand higher over the
		// room (≈23.6 dB against 19). One of its files clips 0.12 % of its
		// samples, but the clearest voice comes first. The DJI wins.
		const { group } = await buildCameraGroup(media, ['dji1', 'dji2', 'dji3', 'iphone'], { sync: fakeSync() })
		expect(soundCameraOf(group, media)?.name).toBe('Cam01')
	})

	it('places a file the sound could not, by continuing its camera’s previous file', async () => {
		const { group } = await buildCameraGroup(media, ['dji1', 'dji2', 'dji3', 'iphone'], { sync: fakeSync('dji3') })
		const dji3 = group.members.find((m) => m.assetId === 'dji3')!
		expect(dji3.sync).toMatchObject({ method: 'continued', confidence: 'weak' })
		// Where the real sync put it, to within the 7 ms the joins differ by.
		expect(dji3.offset).toBeCloseTo(5165.1101, 1)
		const dji2 = group.members.find((m) => m.assetId === 'dji2')!
		expect(dji3.offset).toBeCloseTo(dji2.offset + 2610.304 * dji2.rate, 6)
	})

	it('refuses one camera’s files alone: that is not a multicam', async () => {
		await expect(buildCameraGroup(media, ['dji1', 'dji2'], { sync: fakeSync() })).rejects.toThrow(/one camera/)
	})
})
