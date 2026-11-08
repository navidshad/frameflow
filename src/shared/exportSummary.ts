import type { DeliveryFormat, ExportQuality } from './types'
import { rungOf, sizeText } from './resolution'

/**
 * What an export was started with, in words, for the progress dialog.
 *
 * An export of a long project runs for the better part of an hour, and by then
 * nobody remembers which size or file type they picked. The dialog shows this
 * list so the answer is on screen for as long as the render is.
 */

export interface ExportSummaryRow { label: string; value: string }

export interface ExportFacts {
	width: number
	height: number
	fps: number
	format: DeliveryFormat
	quality: ExportQuality
	/** Timeline length, seconds. */
	seconds: number
	segments: number
	loudness: boolean
	captions: boolean
}

export const FORMAT_LABELS: Record<DeliveryFormat, string> = {
	h264: 'MP4 (H.264)',
	h265: 'MP4 (H.265 / HEVC)',
	prores: 'ProRes 422 HQ (.mov)'
}

/** 867 s is "14:27"; an hour or more is "1:05:09". */
export function clockText(seconds: number): string {
	const total = Math.max(0, Math.round(seconds))
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const pad = (n: number) => String(n).padStart(2, '0')
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function exportSummary(f: ExportFacts): ExportSummaryRow[] {
	const frame = { width: f.width, height: f.height }
	const rung = f.quality === 'preview' ? null : rungOf(frame)
	const size = f.quality === 'preview'
		? `${sizeText(frame)} · fast preview`
		: rung ? `${rung.label} · ${sizeText(frame)}` : sizeText(frame)
	const extras = [
		f.captions ? 'titles and captions burned in' : '',
		f.loudness ? 'loudness levelled' : ''
	].filter(Boolean)
	const rows: ExportSummaryRow[] = [
		{ label: 'Size', value: size },
		{ label: 'File type', value: FORMAT_LABELS[f.format] },
		{ label: 'Frame rate', value: `${Math.round(f.fps * 100) / 100} fps` },
		{ label: 'Length', value: `${clockText(f.seconds)} · ${f.segments} segment${f.segments === 1 ? '' : 's'}` }
	]
	if (extras.length) rows.push({ label: 'Also', value: extras.join(', ') })
	return rows
}
