import { describe, expect, it } from 'vitest'
import { DELIVERY, HEVC_HARDWARE, HEVC_SOFTWARE, deliveryOptions, deliveryPath } from './deliver'

const pair = (opts: string[], flag: string) => opts[opts.indexOf(flag) + 1]

describe('delivery recipes', () => {
	it('H.264 needs no pass at all', () => {
		expect(DELIVERY.h264).toBeNull()
		expect(deliveryOptions('h264', true)).toBeNull()
	})

	it('H.265 is tagged hvc1 on both encoders, so QuickTime plays it', () => {
		for (const hardware of [true, false]) {
			const opts = deliveryOptions('h265', hardware)!
			expect(pair(opts, '-tag:v')).toBe('hvc1')
			expect(pair(opts, '-pix_fmt')).toBe('yuv420p')
			// The AAC the render already made is carried over, not encoded twice.
			expect(pair(opts, '-c:a')).toBe('copy')
			expect(opts).toContain('+faststart')
		}
	})

	it('H.265 uses the hardware encoder when there is one, x265 otherwise', () => {
		expect(pair(deliveryOptions('h265', true)!, '-c:v')).toBe('hevc_videotoolbox')
		expect(pair(deliveryOptions('h265', false)!, '-c:v')).toBe('libx265')
		expect(pair(HEVC_HARDWARE, '-q:v')).toBe('65')
		expect(pair(HEVC_SOFTWARE, '-crf')).toBe('23')
	})

	it('ProRes is 422 HQ in a mov with PCM audio, whatever the hardware', () => {
		for (const hardware of [true, false]) {
			const opts = deliveryOptions('prores', hardware)!
			expect(pair(opts, '-c:v')).toBe('prores_ks')
			expect(pair(opts, '-profile:v')).toBe('3')
			expect(pair(opts, '-pix_fmt')).toBe('yuv422p10le')
			expect(pair(opts, '-c:a')).toBe('pcm_s16le')
		}
		expect(DELIVERY.prores!.extension).toBe('.mov')
	})

	it('writes beside the source, and an H.265 mp4 never lands on the H.264 one', () => {
		const source = '/tmp/exports/Cut_ab12cd34.mp4'
		const h265 = deliveryPath(source, DELIVERY.h265!)
		expect(h265).toBe('/tmp/exports/Cut_ab12cd34_h265.mp4')
		expect(h265).not.toBe(source)
		expect(deliveryPath(source, DELIVERY.prores!)).toBe('/tmp/exports/Cut_ab12cd34.mov')
	})
})
