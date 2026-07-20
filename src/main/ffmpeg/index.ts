import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import ffprobePath from 'ffprobe-static'
import fs from 'fs'
import { join, basename, extname } from 'path'
import process from 'node:process'
import { TimelineSegment, SilenceRegion } from '../../shared/types'

const IS_MAC = process.platform === 'darwin'



/**
 * Returns the absolute path to the unpacked ffmpeg binary.
 */
export function getFFmpegBinaryPath(): string {
	const p = typeof ffmpegPath === 'string' ? ffmpegPath : (ffmpegPath as any).path
	return p.replace('app.asar', 'app.asar.unpacked')
}

// Initializing ffmpeg and ffprobe paths
if (ffmpegPath) {
	ffmpeg.setFfmpegPath(getFFmpegBinaryPath())
}
if (ffprobePath) {
	const p = typeof ffprobePath === 'string' ? ffprobePath : (ffprobePath as any).path
	ffmpeg.setFfprobePath(p.replace('app.asar', 'app.asar.unpacked'))
}

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
				hasAudio: !!audioStream
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
				hasAudio: true
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
 * Converts video to low resolution (480p).
 */
// A proxy for scrubbing / thumbnails / scene detection never needs more than
// this; halving a 60fps source roughly halves proxy encode time.
const PROXY_MAX_FPS = 30

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

	// Cap fps only when the source is above the ceiling — applying fps=30 to a
	// <=30fps source would DUPLICATE frames (slower + larger), not drop any.
	const capFps = !!opts?.sourceFps && opts.sourceFps > PROXY_MAX_FPS
	const vf = capFps ? `fps=${PROXY_MAX_FPS},scale=-2:480` : 'scale=-2:480'

	// Hardware-accelerated DECODE (Mac) is a clear win for decode-bound proxies
	// (~-25%). But when we're already dropping frames via the fps filter,
	// benchmarks show the per-frame GPU→CPU download makes it slower than plain
	// software decode — so only use hw decode when NOT capping fps.
	const preferHwDecode = IS_MAC && !isWebm && !capFps

	const encode = (hwDecode: boolean): Promise<string> => new Promise((resolve, reject) => {
		const command = ffmpeg(filePath)
		if (hwDecode) command.inputOptions(['-hwaccel', 'videotoolbox'])
		command.outputOptions(['-vf', vf])

		if (isWebm) {
			// WebM (VP8/VP9) optimizations
			command.outputOptions([
				'-c:v', 'libvpx-vp9',
				'-deadline', 'realtime',
				'-cpu-used', '8',
				'-threads', '0',
				'-row-mt', '1',
				'-b:v', '1M'
			])
		} else if (IS_MAC) {
			// Mac hardware encode
			command.outputOptions([
				'-c:v', 'h264_videotoolbox',
				'-b:v', '2M',
				'-realtime', 'true',
				'-threads', '0'
			])
		} else {
			// CPU-based x264
			command.outputOptions([
				'-c:v', 'libx264',
				'-preset', 'ultrafast',
				'-crf', '32',
				'-tune', 'fastdecode',
				'-threads', '0'
			])
		}

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
				console.error('FFmpeg toLowResolution error:', err)
				console.error('FFmpeg stderr:', stderr)
				reject(new Error(`FFmpeg failed: ${err.message}. ${stderr}`))
			})
			.run()
	})

	try {
		return await encode(preferHwDecode)
	} catch (err) {
		// Hardware decode can reject some inputs — fall back to software decode
		// once rather than failing the whole proxy step.
		if (!signal?.aborted && preferHwDecode) {
			console.warn('[ffmpeg] hw-decode proxy failed, retrying with software decode:', (err as Error).message)
			return await encode(false)
		}
		throw err
	}
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

	// Helper to parse SRT-style time string or simplified HH:MM:SS to seconds
	const timeToSeconds = (t: string): number => {
		const [time, milli] = t.split(/[.,]/)
		const parts = time.split(':').map(Number)
		let seconds = 0
		if (parts.length === 3) {
			seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
		} else if (parts.length === 2) {
			seconds = parts[0] * 60 + parts[1]
		} else if (parts.length === 1) {
			seconds = parts[0]
		}
		return seconds + (milli ? parseFloat(`0.${milli}`) : 0)
	}

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
			.outputOptions(['-f', 'null'])
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
