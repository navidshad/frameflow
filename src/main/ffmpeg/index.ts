import ffmpeg from 'fluent-ffmpeg'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from './binaries'
import fs from 'fs'
import { join, basename, extname } from 'path'
import process from 'node:process'
import { TimelineSegment, SilenceRegion } from '../../shared/types'
import { srtToSeconds } from '../../shared/timeline'
import { createSlotPool } from '../concurrency'
import { proxyArgs, proxyModes, MAX_SOFTWARE_PROXIES, type ProxyMode } from './proxyArgs'

const IS_MAC = process.platform === 'darwin'



// Re-exported because callers (src/main/ytdlp.ts) import it from this module.
export { getFFmpegBinaryPath, getFFprobeBinaryPath } from './binaries'

// No app.asar -> app.asar.unpacked rewriting any more: extraResources puts
// these binaries outside the archive entirely, so the path is already real.
ffmpeg.setFfmpegPath(getFFmpegBinaryPath())
ffmpeg.setFfprobePath(getFFprobeBinaryPath())

// fluent-ffmpeg validates every input's `-f` against `ffmpeg -formats` before
// running — and `lavfi` is a DEVICE, not a format, so it is never in that list
// and any command with a synthesised input (silence under a still frame, black
// under a gap, a generated background) dies with "Input format lavfi is not
// available" IN THE APP while passing every test that calls the binary
// directly. The capability cache is one shared object, so teaching it about
// lavfi once fixes every command.
ffmpeg.getAvailableFormats((error, formats) => {
	if (!error && formats && !formats.lavfi) {
		formats.lavfi = { description: 'Libavfilter virtual input device', canDemux: true, canMux: false }
	}
})

/**
 * Checks whether ffmpeg is available and functional.
 * Returns true if the embedded binary responds correctly, false otherwise.
 */
export function checkFFmpegAvailability(): Promise<boolean> {
	return new Promise((resolve) => {
		ffmpeg.getAvailableFormats((err) => {
			resolve(!err)
		})
	})
}

/**
 * Sanitizes a filename to ensure it only contains ASCII characters and is not too long.
 */
export function sanitizeFilename(name: string): string {
	// Strip non-ASCII characters
	let sanitized = name.replace(/[^\x00-\x7F]/g, '')
	// Replace spaces and special characters with underscores
	sanitized = sanitized.replace(/[^a-zA-Z0-9.-]/g, '_')
	// Limit length
	if (sanitized.length > 100) {
		const ext = extname(sanitized)
		sanitized = sanitized.substring(0, 100 - ext.length) + ext
	}
	return sanitized || 'file'
}

export interface VideoInfo {

	width: number
	height: number
}

/**
 * Gets the resolution of a video file.
 */
export async function getVideoResolution(filePath: string): Promise<VideoInfo> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) return reject(err)
			const stream = metadata.streams.find((s) => s.codec_type === 'video')
			if (!stream || !stream.width || !stream.height) {
				return reject(new Error('No video stream found or dimensions missing'))
			}
			resolve({
				width: stream.width,
				height: stream.height
			})
		})
	})
}

/**
 * Gets the duration of a video file in seconds.
 */
export async function getVideoDuration(filePath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) return reject(err)
			const duration = metadata.format.duration
			if (duration === undefined) {
				return reject(new Error('Duration missing from metadata'))
			}
			resolve(duration)
		})
	})
}

/**
 * Capture time from the container's creation_time tag, as epoch ms.
 * Checked on the format first, then on any stream — muxers disagree about
 * where it belongs. Returns undefined when absent or unparseable; many
 * exports and re-encodes strip the tag entirely.
 */
function parseRecordedAt(metadata: any): number | undefined {
	const candidates = [
		metadata?.format?.tags?.creation_time,
		...(metadata?.streams || []).map((s: any) => s?.tags?.creation_time)
	]
	for (const value of candidates) {
		if (typeof value !== 'string') continue
		const parsed = Date.parse(value)
		// Guard against placeholder epochs some cameras write when the clock is unset.
		if (Number.isFinite(parsed) && parsed > 0) return parsed
	}
	return undefined
}

/**
 * Gets comprehensive metadata for a video file.
 */
export async function getVideoMetadata(filePath: string): Promise<import('../../shared/types').VideoMetadata> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) return reject(err)
			const videoStream = metadata.streams.find((s) => s.codec_type === 'video')
			const audioStream = metadata.streams.find((s) => s.codec_type === 'audio')
			
			if (!videoStream) {
				return reject(new Error('No video stream found'))
			}

			// Parse FPS
			let fps = 0
			if (videoStream.r_frame_rate) {
				const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
				fps = num / den
			}

			resolve({
				duration: metadata.format.duration || 0,
				width: videoStream.width || 0,
				height: videoStream.height || 0,
				size: metadata.format.size || 0,
				codec: videoStream.codec_name || 'unknown',
				fps: Math.round(fps * 100) / 100,
				format: metadata.format.format_name || 'unknown',
				hasAudio: !!audioStream,
				recordedAt: parseRecordedAt(metadata),
				colorTransfer: videoStream.color_transfer || undefined,
				colorPrimaries: videoStream.color_primaries || undefined,
				pixFmt: videoStream.pix_fmt || undefined
			})
		})
	})
}

/**
 * Metadata for an audio-only source (no video stream). Mirrors VideoMetadata's
 * shape so a MediaAsset can carry it uniformly; width/height/fps are 0 since
 * there is no picture, and the export normalization target ignores audio assets.
 */
export async function getAudioMetadata(filePath: string): Promise<import('../../shared/types').VideoMetadata> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) return reject(err)
			const audioStream = metadata.streams.find((s) => s.codec_type === 'audio')
			if (!audioStream) {
				return reject(new Error('No audio stream found'))
			}
			resolve({
				duration: metadata.format.duration || 0,
				width: 0,
				height: 0,
				size: metadata.format.size || 0,
				codec: audioStream.codec_name || 'unknown',
				fps: 0,
				format: metadata.format.format_name || 'unknown',
				hasAudio: true,
				recordedAt: parseRecordedAt(metadata)
			})
		})
	})
}

/**
 * Returns true if the video resolution is 480p or lower.
 */
export async function isVideoLowResolution(filePath: string): Promise<boolean> {
	try {
		const { height } = await getVideoResolution(filePath)
		return height <= 480
	} catch (error) {
		console.error('Error checking video resolution:', error)
		return false // Assume not low resolution on error
	}
}

/**
 * The rotation a phone wrote into a file (degrees, 0 when none). A file whose
 * picture is stored sideways and turned by a tag needs the CPU scaler, which
 * turns it upright; the GPU scaler would not (see proxyArgs.ts).
 */
export async function getVideoRotation(filePath: string): Promise<number> {
	return new Promise((resolve) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) return resolve(0)
			const stream: any = metadata.streams.find((s) => s.codec_type === 'video')
			const side = (stream?.side_data_list || []).find((d: any) => d?.rotation !== undefined)
			const rotation = Number(side?.rotation ?? stream?.tags?.rotate ?? stream?.rotation ?? 0)
			resolve(Number.isFinite(rotation) ? rotation : 0)
		})
	})
}

// Software proxies use every core: one at a time, however many files are importing.
const softwareProxies = createSlotPool(MAX_SOFTWARE_PROXIES)

/**
 * Converts video to low resolution (480p).
 *
 * Tries the quickest way first (GPU decode and scale on a Mac), then falls back
 * one step at a time (GPU decode with the CPU scaler, then software) so a file
 * the hardware rejects still gets its proxy. See proxyArgs.ts for the plan.
 */
export async function toLowResolution(
	filePath: string,
	outputDir: string,
	onProgress?: (percent: number) => void,
	signal?: AbortSignal,
	opts?: { sourceFps?: number }
): Promise<string> {
	const ext = extname(filePath).toLowerCase()
	const rawFilename = basename(filePath, extname(filePath))
	const filename = sanitizeFilename(rawFilename)
	const outputPath = join(outputDir, `${filename}_480p${ext}`)

	if (signal?.aborted) {
		throw new Error('FFmpeg downscaling aborted by user before start')
	}

	const isWebm = ext === '.webm'
	const plan = { isMac: IS_MAC, isWebm, sourceFps: opts?.sourceFps, rotated: false }
	if (IS_MAC && !isWebm) plan.rotated = (await getVideoRotation(filePath)) % 360 !== 0

	const encode = (mode: ProxyMode): Promise<string> => new Promise((resolve, reject) => {
		const args = proxyArgs(mode, plan)
		const command = ffmpeg(filePath)
		if (args.input.length) command.inputOptions(args.input)
		command.outputOptions(args.output)

		if (signal) {
			signal.addEventListener('abort', () => command.kill('SIGKILL'))
		}

		command
			.output(outputPath)
			.on('progress', (progress) => {
				if (onProgress && progress.percent) {
					onProgress(Math.round(progress.percent))
				}
			})
			.on('end', () => resolve(outputPath))
			.on('error', (err, stdout, stderr) => {
				if (signal?.aborted) {
					return reject(new Error('FFmpeg downscaling aborted by user'))
				}
				console.error(`FFmpeg toLowResolution error (${mode}):`, err)
				console.error('FFmpeg stderr:', stderr)
				reject(new Error(`FFmpeg failed: ${err.message}. ${stderr}`))
			})
			.run()
	})

	const modes = proxyModes(plan)
	let lastError: unknown
	for (let i = 0; i < modes.length; i++) {
		const mode = modes[i]
		try {
			// Software decode is the one that eats the machine: one at a time.
			return mode === 'software' && IS_MAC
				? await softwareProxies.run(() => encode(mode))
				: await encode(mode)
		} catch (err) {
			lastError = err
			if (signal?.aborted) throw err
			if (i < modes.length - 1) {
				console.warn(`[ffmpeg] ${mode} proxy failed, retrying with ${modes[i + 1]}:`, (err as Error).message)
			}
		}
	}
	throw lastError
}

/**
 * The words from a media file, as the transcript wants them: mono, 16 kHz,
 * about 48 kbps (Gemini listens to 16 kbps mono anyway, so more bytes are
 * wasted). Read from the ORIGINAL, so transcript times and the sync and
 * speaker passes run on the same clock; a 91-minute 4K file takes about 10 s
 * and comes out 33 MB.
 */
export async function toLeanAudio(
	filePath: string,
	outputDir: string,
	onProgress?: (percent: number) => void,
	signal?: AbortSignal
): Promise<string> {
	const outputPath = join(outputDir, `${sanitizeFilename(basename(filePath, extname(filePath)))}.mp3`)
	if (signal?.aborted) throw new Error('FFmpeg audio extraction aborted by user before start')

	return new Promise((resolve, reject) => {
		const command = ffmpeg(filePath)
			.noVideo()
			// The first audio track: a phone also writes a 4-channel spatial track.
			.outputOptions(['-map', '0:a:0', '-ac', '1', '-ar', '16000', '-b:a', '48k'])
			.toFormat('mp3')
			.output(outputPath)
			.on('progress', (progress) => {
				if (onProgress && progress.percent) onProgress(Math.round(progress.percent))
			})
			.on('end', () => resolve(outputPath))
			.on('error', (err) => {
				if (signal?.aborted) return reject(new Error('FFmpeg audio extraction aborted by user'))
				reject(err)
			})
		signal?.addEventListener('abort', () => command.kill('SIGKILL'))
		command.run()
	})
}

/**
 * Extracts audio from a video file.
 */
export async function toAudio(
	filePath: string,
	outputDir: string,
	onProgress?: (percent: number) => void,
	signal?: AbortSignal
): Promise<string> {
	const rawFilename = basename(filePath, extname(filePath))
	const filename = sanitizeFilename(rawFilename)
	const outputPath = join(outputDir, `${filename}.mp3`)

	if (signal?.aborted) {
		throw new Error('FFmpeg audio extraction aborted by user before start')
	}

	return new Promise((resolve, reject) => {
		const command = ffmpeg(filePath)
			.toFormat('mp3')
			.output(outputPath)
			.on('progress', (progress) => {
				if (onProgress && progress.percent) {
					onProgress(Math.round(progress.percent))
				}
			})
			.on('end', () => resolve(outputPath))
			.on('error', (err) => {
				if (signal?.aborted) {
					return reject(new Error('FFmpeg audio extraction aborted by user'))
				}
				reject(err)
			})

		if (signal) {
			signal.addEventListener('abort', () => {
				console.log('FFmpeg toAudio aborted by signal')
				command.kill('SIGKILL')
			})
		}

		command.run()
	})
}

/**
 * Cuts [startSec, startSec + durationSec) out of an audio file.
 * Used to transcribe long recordings in windows — one Gemini call cannot
 * transcribe an hour of speech without running into its output ceiling.
 */
export async function extractAudioSegment(
	filePath: string,
	startSec: number,
	durationSec: number,
	outputPath: string,
	signal?: AbortSignal
): Promise<string> {
	if (signal?.aborted) {
		throw new Error('FFmpeg audio segment extraction aborted by user before start')
	}

	return new Promise((resolve, reject) => {
		const command = ffmpeg(filePath)
			// -ss before the input seeks by keyframe (fast); the re-encode below
			// keeps the segment exactly the requested length.
			.setStartTime(startSec)
			.setDuration(durationSec)
			.toFormat('mp3')
			.output(outputPath)
			.on('end', () => resolve(outputPath))
			.on('error', (err) => {
				if (signal?.aborted) {
					return reject(new Error('FFmpeg audio segment extraction aborted by user'))
				}
				reject(err)
			})

		if (signal) {
			signal.addEventListener('abort', () => command.kill('SIGKILL'))
		}

		command.run()
	})
}

/**
 * Assembles a video from segments identified in the timeline.
 * Uses a complex filter to avoid temporary files and ensure efficiency.
 */
export async function assembleVideo(
	videoPath: string,
	segments: TimelineSegment[],
	outputDir: string,
	messageId: string,
	onProgress?: (percent: number) => void,
	signal?: AbortSignal
): Promise<string> {
	const ext = extname(videoPath)
	const rawFilename = basename(videoPath, ext)
	const filename = sanitizeFilename(rawFilename)
	const outputPath = join(outputDir, `${filename}_${messageId}_result${ext}`)


	if (segments.length === 0) {
		throw new Error('No segments provided for assembly')
	}

	if (signal?.aborted) {
		throw new Error('FFmpeg video assembly aborted by user before start')
	}

	// SRT-style time string or plain seconds -> seconds. See shared/timeline.
	const timeToSeconds = srtToSeconds

	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(videoPath, (err, metadata) => {
			if (err) return reject(new Error(`Failed to probe video: ${err.message}`))

			const hasAudio = metadata.streams.some((s) => s.codec_type === 'audio')
			let command = ffmpeg(videoPath)

			// Create filter description for trimming and concatenating
			let filter = ''
			let concatInputs = ''

			segments.forEach((seg, i) => {
				const startSec = timeToSeconds(seg.start)
				const endSec = timeToSeconds(seg.end)
				const duration = endSec - startSec

				// Add video trim and sync
				filter += `[0:v]trim=start=${startSec}:duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[v${i}];`
				concatInputs += `[v${i}]`

				if (hasAudio) {
					// Add audio trim and sync
					filter += `[0:a]atrim=start=${startSec}:duration=${duration},asetpts=PTS-STARTPTS[a${i}];`
					concatInputs += `[a${i}]`
				}
			})

			// Interleaved concat is better for sync: [v0][a0][v1][a1]...concat=n=N:v=1:a=1
			filter += `${concatInputs}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? '[outa]' : ''}`

			command.complexFilter(filter).map('[outv]')
			if (hasAudio) {
				command.map('[outa]')
			}

			const isWebm = ext.toLowerCase() === '.webm'
			const isMp4OrMov = ext.toLowerCase() === '.mp4' || ext.toLowerCase() === '.mov'


			const outputOptions: string[] = []

			if (isWebm) {
				outputOptions.push(
					'-c:v', 'libvpx-vp9',
					'-deadline', 'realtime',
					'-cpu-used', '8',
					'-row-mt', '1',
					'-c:a', 'libvorbis',
					'-b:v', '2M',
					'-threads', '0'
				)
			} else if (IS_MAC) {
				outputOptions.push(
					'-c:v', 'h264_videotoolbox',
					'-b:v', '4M',
					'-realtime', 'true',
					'-c:a', 'aac',
					'-b:a', '128k',
					'-threads', '0'
				)
			} else {
				outputOptions.push(
					'-c:v', 'libx264',
					'-preset', 'ultrafast',
					'-crf', '23',
					'-c:a', 'aac',
					'-b:a', '128k',
					'-threads', '0'
				)
			}

			if (isMp4OrMov) {
				outputOptions.push('-movflags', '+faststart')
			}

			if (signal) {
				signal.addEventListener('abort', () => {
					console.log('FFmpeg assembleVideo aborted by signal')
					command.kill('SIGKILL')
				})
			}

			command
				.output(outputPath)
				.outputOptions(outputOptions)
				.on('start', (cmd) => {
					console.log('FFmpeg logic:', cmd)
				})
				.on('progress', (progress) => {
					if (onProgress && progress.percent) {
						onProgress(Math.round(progress.percent))
					}
				})
				.on('end', () => {
					console.log('Video assembled successfully:', outputPath)
					resolve(outputPath)
				})
				.on('error', (err, stdout, stderr) => {
					if (signal?.aborted) {
						return reject(new Error('FFmpeg video assembly aborted by user'))
					}
					console.error('FFmpeg assembly error:', err)
					console.error('FFmpeg stderr:', stderr)
					reject(new Error(`FFmpeg assembly failed: ${err.message}. ${stderr}`))
				})
				.run()
		})
	})
}

/**
 * Extracts a single frame from a video at a specific timestamp.
 * Resizes to 480p height to minimize token usage for AI analysis.
 */
export async function extractFrame(
	videoPath: string,
	timestamp: number,
	outputDir: string,
	signal?: AbortSignal
): Promise<string> {
	const ext = extname(videoPath)
	const rawFilename = basename(videoPath, ext)
	const filename = sanitizeFilename(rawFilename)
	const outputPath = join(outputDir, `${filename}_frame_${timestamp.toFixed(2)}.jpg`)

	if (signal?.aborted) {
		throw new Error('FFmpeg frame extraction aborted by user before start')
	}

	return new Promise((resolve, reject) => {
		const command = ffmpeg(videoPath)
			.seekInput(timestamp)
			.outputOptions([
				'-vframes', '1',
				'-vf', 'scale=-2:480', // Resize to 480p height, mantaining aspect ratio
				'-q:v', '2' // High quality JPG
			])
			.output(outputPath)
			.on('end', () => resolve(outputPath))
			.on('error', (err) => {
				if (signal?.aborted) {
					return reject(new Error('FFmpeg frame extraction aborted by user'))
				}
				console.error(`Error extracting frame at ${timestamp}:`, err)
				reject(err)
			})

		if (signal) {
			signal.addEventListener('abort', () => {
				console.log('FFmpeg extractFrame aborted by signal')
				command.kill('SIGKILL')
			})
		}

		command.run()
	})
}

/**
 * Batched filmstrip extractor (PRD §5.5). ONE ffmpeg pass samples a frame
 * every `intervalSec` seconds (`fps=1/interval`) at 120px height — unlike
 * extractFrame's process-per-frame, a multi-hour source stays a single
 * bounded run. Returns entries mapping each frame to its source time.
 */
export async function generateFilmstrip(
	videoPath: string,
	outputDir: string,
	intervalSec: number,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<{ time: number; thumbnailPath: string }[]> {
	if (signal?.aborted) {
		throw new Error('Filmstrip generation aborted before start')
	}

	const pattern = join(outputDir, 'strip_%05d.jpg')

	await new Promise<void>((resolve, reject) => {
		const command = ffmpeg(videoPath)
			.outputOptions([
				'-vf', `fps=1/${intervalSec},scale=-2:120`,
				'-q:v', '5'
			])
			.output(pattern)
			.on('progress', (progress) => {
				if (onProgress && progress.percent) {
					onProgress(Math.round(progress.percent))
				}
			})
			.on('end', () => resolve())
			.on('error', (err) => {
				if (signal?.aborted) {
					return reject(new Error('Filmstrip generation aborted by user'))
				}
				console.error('Error generating filmstrip:', err)
				reject(err)
			})

		if (signal) {
			signal.addEventListener('abort', () => command.kill('SIGKILL'))
		}

		command.run()
	})

	return fs.readdirSync(outputDir)
		.filter((f) => /^strip_\d+\.jpg$/.test(f))
		.sort()
		.map((f, i) => ({
			// fps=1/N emits the frame representing window [iN, (i+1)N) — stamp it
			// at the window centre so nearest-entry lookup lands inside the window.
			time: (i + 0.5) * intervalSec,
			thumbnailPath: join(outputDir, f)
		}))
}

/**
 * Assistive silence/dead-air finder (PRD §5.6). Runs ffmpeg's `silencedetect`
 * audio filter over the source and parses the `silence_start`/`silence_end`
 * markers off stderr into source-time regions. Read-only analysis — it never
 * mutates media; the caller reviews the ranges before applying any cut.
 *
 * Requires an audio stream — guard with `metadata.hasAudio` before calling.
 */
/**
 * Output options for the silence finder. `-vn -sn -dn`: only the sound is read.
 * Without them ffmpeg decodes the picture too and throws it away, which on a
 * 4K HEVC camera file is most of the work (a 43-minute DJI file took over ten
 * minutes instead of under one).
 */
export const SILENCE_OUTPUT_OPTIONS = ['-vn', '-sn', '-dn', '-f', 'null']

export async function detectSilence(
	videoPath: string,
	opts?: { noiseDb?: number; minDurationSec?: number },
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<SilenceRegion[]> {
	const noiseDb = opts?.noiseDb ?? -30
	const minDurationSec = opts?.minDurationSec ?? 0.5

	if (signal?.aborted) {
		throw new Error('Silence detection aborted before start')
	}

	return new Promise((resolve, reject) => {
		const regions: SilenceRegion[] = []
		let pendingStart: number | null = null

		const command = ffmpeg(videoPath)
			.audioFilters(`silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`)
			.outputOptions(SILENCE_OUTPUT_OPTIONS)
			.output(process.platform === 'win32' ? 'NUL' : '/dev/null')
			.on('progress', (progress) => {
				if (onProgress && progress.percent) {
					onProgress(Math.round(progress.percent))
				}
			})
			.on('stderr', (line: string) => {
				const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/)
				if (startMatch) {
					pendingStart = parseFloat(startMatch[1])
					return
				}
				const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/)
				if (endMatch) {
					const end = parseFloat(endMatch[1])
					const start = Math.max(0, pendingStart ?? 0)
					if (Number.isFinite(end) && end > start) regions.push({ start, end })
					pendingStart = null
				}
			})
			.on('end', () => resolve(regions))
			.on('error', (err) => {
				if (signal?.aborted) {
					return reject(new Error('Silence detection aborted by user'))
				}
				console.error('Error during silence detection:', err)
				reject(err)
			})

		if (signal) {
			signal.addEventListener('abort', () => command.kill('SIGKILL'))
		}

		command.run()
	})
}

/**
 * Loudness (RMS dB) of every 50 ms of audio, mono at 16 kHz. The transcript
 * pipeline finds pauses and speech onsets from this (gemini/transcript-timing.ts).
 * Digital silence reads as -Infinity. About a second per ten minutes of audio.
 */
export async function measureLoudness(audioPath: string, signal?: AbortSignal): Promise<number[]> {
	if (signal?.aborted) throw new Error('Loudness measurement aborted before start')
	const FRAME_SAMPLES = 800 // 50 ms at 16 kHz — keep in step with LOUDNESS_FRAME_SEC
	return new Promise((resolve, reject) => {
		const levels: number[] = []
		let frame = -1
		const command = ffmpeg(audioPath)
			.noVideo()
			.audioFilters([
				'aformat=sample_rates=16000:channel_layouts=mono',
				`asetnsamples=n=${FRAME_SAMPLES}:p=0`,
				'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level',
				'ametadata=print:key=lavfi.astats.Overall.RMS_level'
			])
			.outputOptions(['-f', 'null'])
			.output(process.platform === 'win32' ? 'NUL' : '/dev/null')
			.on('stderr', (line: string) => {
				const pts = line.match(/pts_time:\s*([\d.]+)/)
				if (pts) { frame = Math.round(parseFloat(pts[1]) * 16000 / FRAME_SAMPLES); return }
				const level = line.match(/RMS_level=(\S+)/)
				if (level && frame >= 0) {
					const value = parseFloat(level[1])
					levels[frame] = Number.isFinite(value) ? value : -Infinity
				}
			})
			.on('end', () => {
				for (let i = 0; i < levels.length; i++) if (levels[i] === undefined) levels[i] = -Infinity
				resolve(levels)
			})
			.on('error', (err) => {
				if (signal?.aborted) return reject(new Error('Loudness measurement aborted by user'))
				reject(err)
			})
		if (signal) signal.addEventListener('abort', () => command.kill('SIGKILL'), { once: true })
		command.run()
	})
}
