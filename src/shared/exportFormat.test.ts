import { describe, expect, it } from 'vitest'
import { formatExportDate, formatFileSize } from './exportFormat'

describe('formatFileSize', () => {
	it('uses the largest unit that keeps the number small', () => {
		expect(formatFileSize(0)).toBe('0 B')
		expect(formatFileSize(512)).toBe('512 B')
		expect(formatFileSize(12 * 1024)).toBe('12 KB')
		expect(formatFileSize(340 * 1024 * 1024)).toBe('340 MB')
		expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
		expect(formatFileSize(2.6 * 1024 ** 3)).toBe('2.6 GB')
		expect(formatFileSize(1023.9 * 1024 ** 2)).toBe('1 GB')
	})
	it('returns nothing for a size it cannot trust', () => {
		expect(formatFileSize(NaN)).toBe('')
		expect(formatFileSize(-1)).toBe('')
	})
})

describe('formatExportDate', () => {
	const now = new Date(2026, 9, 26, 15, 0).getTime()
	const ago = (ms: number) => now - ms
	const MIN = 60000
	const HOUR = 60 * MIN
	it('is relative for the first day', () => {
		expect(formatExportDate(ago(10_000), now)).toBe('just now')
		expect(formatExportDate(ago(12 * MIN), now)).toBe('12m ago')
		expect(formatExportDate(ago(3 * HOUR), now)).toBe('3h ago')
	})
	it('says Yesterday by calendar day, then days, then a date', () => {
		expect(formatExportDate(new Date(2026, 9, 25, 9, 0).getTime(), now)).toBe('Yesterday')
		expect(formatExportDate(new Date(2026, 9, 23, 9, 0).getTime(), now)).toBe('3d ago')
		expect(formatExportDate(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe('Oct 12')
		expect(formatExportDate(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe('Dec 31, 2025')
	})
})
