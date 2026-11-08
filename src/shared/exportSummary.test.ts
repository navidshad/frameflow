import { describe, expect, it } from 'vitest'
import { clockText, exportSummary } from './exportSummary'

const base = { width: 3840, height: 2160, fps: 30, format: 'h264' as const, quality: 'original' as const, seconds: 867, segments: 195, loudness: false, captions: false }

describe('exportSummary', () => {
	it('says what was asked for, in the words of the export dialog', () => {
		expect(exportSummary(base)).toEqual([
			{ label: 'Size', value: '4K · 3840×2160' },
			{ label: 'File type', value: 'MP4 (H.264)' },
			{ label: 'Frame rate', value: '30 fps' },
			{ label: 'Length', value: '14:27 · 195 segments' }
		])
	})

	it('names a smaller size by its rung, the preview as a preview, and an odd size by its numbers', () => {
		expect(exportSummary({ ...base, width: 1920, height: 1080 })[0].value).toBe('1080p · 1920×1080')
		expect(exportSummary({ ...base, width: 854, height: 480, quality: 'preview' })[0].value).toBe('854×480 · fast preview')
		expect(exportSummary({ ...base, width: 1000, height: 900 })[0].value).toBe('1000×900')
	})

	it('lists the other file types and the extra passes only when they apply', () => {
		const rows = exportSummary({ ...base, format: 'h265', loudness: true, captions: true, segments: 1 })
		expect(rows[1].value).toBe('MP4 (H.265 / HEVC)')
		expect(rows[3].value).toBe('14:27 · 1 segment')
		expect(rows[4]).toEqual({ label: 'Also', value: 'titles and captions burned in, loudness levelled' })
	})

	it('writes a clock, with hours only when there are some', () => {
		expect(clockText(867)).toBe('14:27')
		expect(clockText(3909)).toBe('1:05:09')
		expect(clockText(0)).toBe('0:00')
	})
})
