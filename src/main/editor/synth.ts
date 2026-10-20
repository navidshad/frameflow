import { createHash } from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { MediaAsset } from '../../shared/types'
import { normaliseRecipe, presetOf, recipeKey, soundFinish, soundGraph, soundLength, soundPeakDb, SR, type SoundRecipe } from '../../shared/synth'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { threadManager } from '../threads'
import { createMediaAsset, getAssetDir, patchAsset } from './assets'
import { previewPeaks } from './audioAnalysis'

/**
 * Render a recipe to a WAV, and keep it.
 *
 * A sound is a recipe first and a file second: the file is named by a hash of
 * the recipe, so the same recipe is the same file on every run and nothing is
 * rendered twice. Rendering is an ffmpeg graph with no inputs, tens to hundreds
 * of milliseconds for an effect.
 *
 * Bump SYNTH_VERSION when a recipe's graph changes, so stale files are not
 * reused for a sound that now sounds different.
 */
const SYNTH_VERSION = 'synth-v2'

export const soundHash = (recipe: SoundRecipe): string =>
	createHash('sha1').update(`${SYNTH_VERSION}|${recipeKey(recipe)}`).digest('hex').slice(0, 16)

/** The asset id a recipe's sound has in a project: the same sound is one asset. */
export const soundAssetId = (recipe: SoundRecipe): string => `synth-${soundHash(recipe)}`

const soundDir = (tempDir: string) => path.join(tempDir, 'synth')

/** A 16-bit PCM WAV: the header, then the samples. */
function wavBytes(samples: Int16Array, channels: number): Buffer {
	const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
	const header = Buffer.alloc(44)
	header.write('RIFF', 0)
	header.writeUInt32LE(36 + data.length, 4)
	header.write('WAVEfmt ', 8)
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20)
	header.writeUInt16LE(channels, 22)
	header.writeUInt32LE(SR, 24)
	header.writeUInt32LE(SR * channels * 2, 28)
	header.writeUInt16LE(channels * 2, 32)
	header.writeUInt16LE(16, 34)
	header.write('data', 36)
	header.writeUInt32LE(data.length, 40)
	return Buffer.concat([header, data])
}

/**
 * Run the graph and write the result to `outPath`.
 *
 * ffmpeg synthesises to raw float samples; the level is applied HERE, because a
 * recipe's level is the sound's peak and the peak is only known once it exists.
 * Scaling to an exact peak means no limiter is needed (nothing can clip), and a
 * click and a chime of the same level really are as loud as each other.
 */
export function renderSoundFile(recipe: SoundRecipe, outPath: string): Promise<{ lengthSec: number; ms: number }> {
	const started = Date.now()
	const lengthSec = soundLength(recipe)
	const channels = 2
	const graph = `${soundGraph(recipe)};${soundFinish(recipe)}`
	return new Promise((resolve, reject) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-y', '-v', 'error', '-nostdin',
			'-filter_complex', graph, '-map', '[final]',
			'-t', String(lengthSec + 0.05), '-ar', String(SR), '-f', 'f32le', '-'
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		const chunks: Buffer[] = []
		let stderr = ''
		child.stdout.on('data', (d: Buffer) => chunks.push(d))
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
		child.on('error', reject)
		child.on('close', (code) => {
			const raw = Buffer.concat(chunks)
			const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4))
			let peak = 0
			for (let i = 0; i < floats.length; i++) {
				const v = Math.abs(floats[i])
				if (v > peak) peak = v
			}
			if (code !== 0 || !floats.length || peak === 0) {
				return reject(new Error(`Could not render the ${recipe.kind} sound: ${stderr.trim().split('\n').pop() || (peak === 0 ? 'it came out silent' : `ffmpeg exited with ${code}`)}`))
			}
			const scale = 10 ** (soundPeakDb(recipe) / 20) / peak
			const pcm = new Int16Array(floats.length)
			for (let i = 0; i < floats.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(floats[i] * scale * 32767)))
			fs.writeFileSync(outPath, wavBytes(pcm, channels))
			resolve({ lengthSec, ms: Date.now() - started })
		})
	})
}

/** The file for a recipe in a folder, rendered if it is not there yet. */
export async function ensureSoundFile(
	dir: string, recipe: SoundRecipe
): Promise<{ path: string; lengthSec: number; ms: number; cached: boolean }> {
	fs.mkdirSync(dir, { recursive: true })
	const file = path.join(dir, `${soundHash(recipe)}.wav`)
	if (fs.existsSync(file) && fs.statSync(file).size > 44) {
		return { path: file, lengthSec: soundLength(recipe), ms: 0, cached: true }
	}
	const { lengthSec, ms } = await renderSoundFile(recipe, file)
	return { path: file, lengthSec, ms, cached: false }
}

/** To audition: the file and a few bars of its shape for the palette's little waveform. */
export async function previewSound(threadId: string, recipe: SoundRecipe) {
	const thread = threadManager.getThread(threadId)
	if (!thread) throw new Error('Project not found')
	const out = await ensureSoundFile(soundDir(thread.tempDir), recipe)
	return { ...out, peaks: await previewPeaks(out.path, 40) }
}

/**
 * The project's asset for a recipe: found if the same sound was already made,
 * otherwise rendered and added as an audio asset that remembers its recipe.
 * Asset ids are derived from the recipe, so this is safe to call twice.
 */
export async function ensureSoundAsset(threadId: string, recipe: SoundRecipe): Promise<MediaAsset> {
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor' || !thread.editor) throw new Error('Not an editor project')
	const id = soundAssetId(recipe)
	const existing = thread.editor.media.find((a) => a.id === id)
	if (existing) return existing

	const file = await ensureSoundFile(soundDir(thread.tempDir), recipe)
	const normal = normaliseRecipe(recipe)
	const preset = presetOf(recipe.kind)
	const name = preset.variants > 1 ? `${preset.label} ${normal.variant + 1}` : preset.label
	const asset = await createMediaAsset(threadId, { sourcePath: file.path, name, assetId: id, referenceInPlace: true, deriveTitle: false })
	if (!asset) throw new Error('Could not add the sound to the project')
	// A synthesised sound has nothing to detect, describe or transcribe.
	await patchAsset(threadId, id, { preprocessState: 'completed', synth: normal })
	return threadManager.getThread(threadId)?.editor?.media.find((a) => a.id === id) ?? asset
}

export { getAssetDir }
