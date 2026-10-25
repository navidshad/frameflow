import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { MOTION_FONT_CSS } from '@shared/motion-templates/fonts'

/**
 * Looking at an exported file, for an agent that cannot watch it: what the
 * file is (length, size, streams) and contact sheets of its frames, each
 * labelled with its time. It reads the FILE that shipped, not the timeline,
 * so it is the check that the export came out as the edit said.
 *
 * Plain child processes on the vendored binaries and no Electron, so the test
 * runs it on a real file.
 */

export interface ExportFacts {
	file: string
	bytes: number
	durationSec: number
	width: number | null
	height: number | null
	fps: number | null
	videoCodec: string | null
	videoFrames: number | null
	audioCodec: string | null
	sampleRate: number | null
	channels: number | null
}

function run(binary: string, args: string[], timeoutMs = 60_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${path.basename(binary)} failed: ${String(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`))
			else resolve(stdout)
		})
	})
}

const rate = (r: string | undefined): number | null => {
	if (!r) return null
	const [n, d] = r.split('/').map(Number)
	const v = d ? n / d : n
	return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null
}

export async function probeExport(file: string): Promise<ExportFacts> {
	if (!fs.existsSync(file)) throw new Error(`No file at ${file}`)
	const out = await run(getFFprobeBinaryPath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])
	const info = JSON.parse(out) as { streams?: any[]; format?: any }
	const video = info.streams?.find((s) => s.codec_type === 'video')
	const audio = info.streams?.find((s) => s.codec_type === 'audio')
	return {
		file,
		bytes: Number(info.format?.size) || fs.statSync(file).size,
		durationSec: Math.round((Number(info.format?.duration) || 0) * 1000) / 1000,
		width: video?.width ?? null,
		height: video?.height ?? null,
		fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
		videoCodec: video?.codec_name ?? null,
		videoFrames: video?.nb_frames ? Number(video.nb_frames) : null,
		audioCodec: audio?.codec_name ?? null,
		sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
		channels: audio?.channels ?? null
	}
}

export const MAX_SHEET_FRAMES = 48

/**
 * Which instants a sheet shows: the times asked for, or every `everySec` from
 * `fromSec` to `toSec`, kept inside the file and capped. A step too small for
 * the cap is widened rather than the range cut short, so a sheet always spans
 * what was asked.
 */
export function sheetTimes(durationSec: number, options: { times?: number[]; fromSec?: number; toSec?: number; everySec?: number; max?: number }): number[] {
	const max = Math.min(options.max ?? MAX_SHEET_FRAMES, MAX_SHEET_FRAMES)
	const last = Math.max(0, durationSec - 0.05)
	const clampT = (t: number) => Math.round(Math.min(Math.max(0, t), last) * 1000) / 1000
	if (options.times?.length) return [...new Set(options.times.filter(Number.isFinite).map(clampT))].sort((a, b) => a - b).slice(0, max)
	const from = clampT(options.fromSec ?? 0)
	const to = clampT(options.toSec ?? durationSec)
	if (to <= from) return [from]
	let step = options.everySec && options.everySec > 0 ? options.everySec : (to - from) / Math.max(1, max - 1)
	if ((to - from) / step + 1 > max) step = (to - from) / (max - 1)
	const out: number[] = []
	for (let t = from; t <= to + 1e-6 && out.length < max; t += step) out.push(clampT(t))
	return out
}

/** "1:23.4" */
export function sheetClock(t: number): string {
	const tenths = Math.round(t * 10)
	const m = Math.floor(tenths / 600)
	const s = (tenths % 600) / 10
	return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

let fontFile: string | null = null
/** Inter, written out once from the bundled motion fonts so drawtext can label tiles. */
function labelFont(): string | null {
	if (fontFile && fs.existsSync(fontFile)) return fontFile
	// The first Inter face is the Latin one; a later one maps Arabic script to Vazirmatn.
	const b64 = MOTION_FONT_CSS.match(/font-family:'Inter';src:url\(data:font\/woff2;base64,([^)]+)\)/)?.[1]
	if (!b64) return null
	const file = path.join(os.tmpdir(), 'frameflow-sheet-inter.woff2')
	fs.writeFileSync(file, Buffer.from(b64, 'base64'))
	fontFile = file
	return file
}

export interface SheetOptions {
	tileWidth?: number
	columns?: number
	workDir?: string
}

const drawLabel = (label: string, tileWidth: number): string => {
	const font = labelFont()
	if (!font) return ''
	const text = label.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '')
	return `,drawtext=fontfile='${font.replace(/'/g, "\\'")}':text='${text}':x=6:y=6:fontsize=${Math.round(tileWidth / 14)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`
}

/**
 * Pictures (any size, any format ffmpeg reads) tiled into one JPEG, each
 * scaled to `tileWidth` and labelled in its corner.
 */
export async function tileImages(files: string[], labels: string[], options: SheetOptions = {}): Promise<{ jpeg: Buffer; columns: number; rows: number }> {
	if (!files.length) throw new Error('Nothing to tile')
	const tileWidth = Math.max(160, Math.min(640, Math.round(options.tileWidth ?? 320)))
	const columns = Math.max(1, Math.min(files.length, Math.round(options.columns ?? (files.length <= 4 ? files.length : 6))))
	const rows = Math.ceil(files.length / columns)
	const work = fs.mkdtempSync(path.join(options.workDir ?? os.tmpdir(), 'ff-tile-'))
	try {
		for (let i = 0; i < files.length; i++) {
			await run(getFFmpegBinaryPath(), [
				'-v', 'error', '-i', files[i], '-frames:v', '1',
				'-vf', `scale=${tileWidth}:-2${labels[i] ? drawLabel(labels[i], tileWidth) : ''}`, '-q:v', '3', '-y',
				path.join(work, `t${String(i).padStart(3, '0')}.jpg`)
			])
		}
		const sheet = path.join(work, 'sheet.jpg')
		await run(getFFmpegBinaryPath(), [
			'-v', 'error', '-framerate', '1', '-i', path.join(work, 't%03d.jpg'),
			'-vf', `tile=${columns}x${rows}:padding=4:margin=4:color=0x18181b`, '-frames:v', '1', '-q:v', '3', '-y', sheet
		])
		return { jpeg: fs.readFileSync(sheet), columns, rows }
	} finally {
		fs.rmSync(work, { recursive: true, force: true })
	}
}

/**
 * Frames of a file at the given instants, tiled into one JPEG with each
 * tile's time in its corner. Frames are cut with an input seek, which decodes
 * from the key frame before and lands on the exact frame.
 */
export async function contactSheet(file: string, times: number[], options: SheetOptions = {}): Promise<{ jpeg: Buffer; columns: number; rows: number }> {
	if (!times.length) throw new Error('No times to show')
	const work = fs.mkdtempSync(path.join(options.workDir ?? os.tmpdir(), 'ff-sheet-'))
	try {
		const frames: string[] = []
		for (let i = 0; i < times.length; i++) {
			const out = path.join(work, `f${String(i).padStart(3, '0')}.png`)
			await run(getFFmpegBinaryPath(), [
				'-v', 'error', '-ss', times[i].toFixed(3), '-i', file, '-frames:v', '1',
				'-vf', 'scale=640:-2', '-y', out
			])
			frames.push(out)
		}
		return await tileImages(frames, times.map(sheetClock), options)
	} finally {
		fs.rmSync(work, { recursive: true, force: true })
	}
}

/** The integrated loudness (LUFS) and true peak (dBTP) of the file's sound. */
export async function measureExportLoudness(file: string): Promise<{ lufs: number | null; truePeakDb: number | null }> {
	const out = await new Promise<string>((resolve) => {
		execFile(getFFmpegBinaryPath(), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
			{ maxBuffer: 64 * 1024 * 1024, timeout: 300_000 }, (_error, _stdout, stderr) => resolve(String(stderr)))
	})
	const summary = out.slice(out.lastIndexOf('Summary:'))
	const lufs = summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]
	const peak = summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]
	return { lufs: lufs ? Number(lufs) : null, truePeakDb: peak ? Number(peak) : null }
}
