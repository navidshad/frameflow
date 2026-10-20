import ffmpeg from 'fluent-ffmpeg'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import type { EditorDocument } from '@shared/types'
import { threadManager } from '../threads'
import { THREAD_DIRS } from '../constants/paths'
import { computeRegions, intermediateOpts, runCommand } from './render'
import { cuesForDoc, transcriptsForDoc } from './captions'
import { cuesAtInstant, cuesToAss, escapeSubtitlesPath } from '@shared/captions'
import { motionCacheDir } from '../motion/cache'
import { ensureMotionJobs } from '../motion'
import {
	buildRegionGraph, motionJobsFor, regionAtInstant,
	type OverlapRegion, type Region, type RegionPlan
} from './renderBuilders'

/**
 * Transition preview cache (ROADMAP Phase 1 §Transitions, item 5).
 *
 * The monitor cannot composite a wipe or a slide — it stacks two <video>
 * elements, so on its own it can only cross-fade. This is the standard NLE
 * answer instead: render the transition window in the background at proxy
 * quality and let the monitor play THAT file, so what you see is what exports.
 *
 * It is cheap here because the export engine already produces exactly this: an
 * overlap region is one self-contained window, and `buildRegionGraph` already
 * emits its filtergraph. This module only picks the region out of the plan,
 * shrinks it, and caches the result.
 */

/** Long edge of a cached preview. These show motion, not detail. */
const PREVIEW_MAX_EDGE = 640
const PREVIEW_MAX_FPS = 30
/** Files kept per project before the oldest are swept. */
const CACHE_LIMIT = 60

const previewDir = (tempDir: string) => path.join(tempDir, THREAD_DIRS.PREVIEWS)

/**
 * Everything that changes what the window looks like — derived, not listed.
 *
 * The first version of this hashed a curated field list, and the list went
 * stale the moment Phase 2 landed: effects, framing, transform, keyframes,
 * keys, gain and fades all reached the window's filtergraph and none of them
 * reached the key, so grading a clip beside a transition kept serving the old
 * render. The audit caught it, and the fix is to stop maintaining a list at
 * all: hash the GRAPH the render would run, plus each real input's identity on
 * disk. The key cannot drift from the picture, because it IS the picture's
 * recipe.
 */
export function graphKey(region: OverlapRegion, plan: RegionPlan): string {
	const graph = buildRegionGraph(region, plan)
	const inputs = graph.inputs.map((input) => {
		let identity = ''
		if (!input.format) {
			// A re-exported or replaced file at the same path must re-render too.
			try {
				const stat = fs.statSync(input.path)
				identity = `${stat.mtimeMs}:${stat.size}`
			} catch { identity = 'missing' }
		}
		return `${input.path}|${input.options.join(' ')}|${identity}`
	})
	const parts = [
		...graph.filters,
		...inputs,
		`${plan.width}x${plan.height}@${plan.fps}`,
		intermediateOpts().join(' ')
	]
	return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/** Shrink the export plan to something that encodes in about a second. */
export function previewPlan(plan: RegionPlan): RegionPlan {
	const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(plan.width, plan.height))
	const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
	return {
		...plan,
		width: even(plan.width * scale),
		height: even(plan.height * scale),
		fps: Math.min(PREVIEW_MAX_FPS, plan.fps)
	}
}

/**
 * Suffix for a render in progress. It has to keep the `.mp4` extension:
 * ffmpeg picks its muxer from the filename, and a `.mp4.part` name fails with
 * "Unable to choose an output format" — which silently broke every preview.
 */
const PARTIAL_SUFFIX = '.part.mp4'

/** Keep the newest N files; a long editing session would otherwise accumulate. */
function sweep(dir: string): void {
	try {
		const files = fs.readdirSync(dir)
			.filter((f) => f.endsWith('.mp4') && !f.endsWith(PARTIAL_SUFFIX))
			.map((f) => {
				const full = path.join(dir, f)
				return { full, at: fs.statSync(full).mtimeMs }
			})
			.sort((a, b) => b.at - a.at)
		for (const stale of files.slice(CACHE_LIMIT)) {
			try { fs.unlinkSync(stale.full) } catch { /* ignore */ }
		}
	} catch { /* the directory may not exist yet */ }
}

/**
 * Encode one transition window to `outputPath`.
 *
 * Split out so it can be exercised against the real binary — the filename
 * bug above was invisible to every unit test, because nothing ran ffmpeg.
 */
export async function renderTransitionWindow(
	region: OverlapRegion,
	plan: RegionPlan,
	outputPath: string
): Promise<void> {
	const graph = buildRegionGraph(region, plan)
	const command = ffmpeg()
	for (const input of graph.inputs) {
		const added = command.input(input.path)
		// NOT `.inputFormat()`: fluent-ffmpeg validates that against `-formats`,
		// and lavfi is a DEVICE, not a format — the check rejects it and the
		// whole render dies with "Input format lavfi is not available". Passing
		// `-f` as a plain option skips the misguided validation.
		added.inputOptions(input.format ? ['-f', input.format, ...input.options] : input.options)
	}
	command
		.complexFilter(graph.filters.join(';'))
		.map(graph.video)
		.map(graph.audio)
		.outputOptions([...intermediateOpts(), '-t', region.duration.toFixed(3)])

	// Encode to a sibling name and rename, so a crash mid-encode cannot leave a
	// truncated file sitting at a key that would read as a cache hit forever.
	const partial = outputPath.replace(/\.mp4$/, PARTIAL_SUFFIX)
	await runCommand(command, partial, new AbortController().signal)
	fs.renameSync(partial, outputPath)
}

/** In-flight renders, so two requests for the same window share one encode. */
const inFlight = new Map<string, Promise<string>>()

/**
 * Render (or return a cached) preview of the transition on the cut between two
 * clips. Resolves to an absolute path the renderer can load through `media://`.
 *
 * Throws when the junction carries no resolvable transition — the caller only
 * asks for seams whose window resolved, so that is a programming error rather
 * than a user-facing state.
 */
export async function ensureTransitionPreview(options: {
	threadId: string
	doc: EditorDocument
	outgoingId: string
	incomingId: string
}): Promise<{ path: string; key: string }> {
	const { threadId, doc, outgoingId, incomingId } = options
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor') throw new Error('Not an editor project')

	// Proxy quality: computeRegions already resolves proxyPath for 'preview'.
	// Transcripts ride along so a bed inside the window ducks in the cached
	// render exactly as it will in the export (it silently did not, before).
	const full = computeRegions(doc, 'preview', transcriptsForDoc(doc), {
		motionDir: motionCacheDir(thread.tempDir)
	})
	const plan = previewPlan(full)
	const region = full.regions.find(
		(r): r is OverlapRegion =>
			r.kind === 'overlap' && r.from.item.id === outgoingId && r.to.item.id === incomingId
	)
	if (!region) throw new Error('No transition on that cut.')

	const key = graphKey(region, plan)
	const dir = previewDir(thread.tempDir)
	const outputPath = path.join(dir, `${key}.mp4`)

	if (fs.existsSync(outputPath)) return { path: outputPath, key }

	const running = inFlight.get(outputPath)
	if (running) return { path: await running, key }

	const job = (async () => {
		fs.mkdirSync(dir, { recursive: true })
		await ensureMotionJobs(motionJobsFor([region]))
		await renderTransitionWindow(region, plan, outputPath)
		sweep(dir)
		return outputPath
	})()

	inFlight.set(outputPath, job)
	try {
		return { path: await job, key }
	} finally {
		inFlight.delete(outputPath)
	}
}

// ===== The exact frame =====

/**
 * Render the ONE frame under the playhead, through the real export graph.
 *
 * This exists because the monitor is honest about its limits: CSS has no chroma
 * key, no LUT, no gamma, and draws one overlay layer where the export
 * composites every track. Rather than approximating those (close-but-wrong is
 * worse than honestly absent), the monitor asks the export pipeline for the
 * truth — one frame, at sequence resolution, in a couple of hundred
 * milliseconds.
 *
 * Full quality on purpose: a truth frame rendered from the proxies would
 * inherit the proxy's own divergence and reproduce the failure it exists to
 * prevent.
 *
 * Cut regions are advanced to the instant with `regionAtInstant`, so the seek
 * happens on the INPUT — a one-hour clip is one region, and output-seeking to
 * 59:00 would decode an hour. Overlap regions keep their full graph and seek on
 * the output instead: xfade's progress depends on the filter's own `t`, and a
 * window is a few seconds at most.
 *
 * Known, accepted divergence: a generated layer's TIME restarts at the frame
 * (grain pattern, gradient drift phase). Its colour, shape and stacking are
 * exact, and grain is random anyway.
 */
export async function renderExactFrame(options: {
	threadId: string
	doc: EditorDocument
	timeSec: number
}): Promise<{ path: string }> {
	const { threadId, doc, timeSec } = options
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor') throw new Error('Not an editor project')

	const plan = computeRegions(doc, 'original', transcriptsForDoc(doc), {
		motionDir: motionCacheDir(thread.tempDir)
	})
	let cursor = 0
	let region: Region | null = null
	let local = 0
	for (const r of plan.regions) {
		if (timeSec < cursor + r.duration || r === plan.regions[plan.regions.length - 1]) {
			region = r
			local = Math.min(Math.max(0, timeSec - cursor), Math.max(0, r.duration - 1 / plan.fps))
			break
		}
		cursor += r.duration
	}
	if (!region) throw new Error('Nothing on the timeline at that time.')

	const still = region.kind === 'cut' ? regionAtInstant(region, local, plan.fps) : region
	// A motion layer in the frame is its rendered clip, so render it first. The
	// first exact frame over a new look pays for the whole clip; every frame
	// after it, and the export, reuse the file.
	await ensureMotionJobs(motionJobsFor([still]))
	const graph = buildRegionGraph(still, plan)

	const command = ffmpeg()
	for (const input of graph.inputs) {
		const added = command.input(input.path)
		// NOT `.inputFormat()`: fluent-ffmpeg validates that against `-formats`,
		// and lavfi is a DEVICE, not a format — the check rejects it and the
		// whole render dies with "Input format lavfi is not available". Passing
		// `-f` as a plain option skips the misguided validation.
		added.inputOptions(input.format ? ['-f', input.format, ...input.options] : input.options)
	}
	command
		// The graph's audio leg is mandatory, and a still frame has no sound —
		// sink it, or ffmpeg refuses the unconnected output.
		.complexFilter([...graph.filters, `${graph.audio}anullsink`].join(';'))
		.map(graph.video)
		.outputOptions([
			...(region.kind === 'overlap' ? ['-ss', local.toFixed(3)] : []),
			'-frames:v', '1'
		])

	const dir = previewDir(thread.tempDir)
	fs.mkdirSync(dir, { recursive: true })
	// A fresh name per render: the renderer shows this in an <img>, and a stable
	// name would be served from the browser's cache — the one failure an "exact"
	// frame must never have. The previous frames are swept here instead.
	for (const stale of fs.readdirSync(dir)) {
		if (stale.startsWith('exact-')) {
			try { fs.unlinkSync(path.join(dir, stale)) } catch { /* ignore */ }
		}
	}
	const outputPath = path.join(dir, `exact-${Date.now()}.png`)
	const partial = outputPath.replace(/\.png$/, '.part.png')
	await runCommand(command, partial, new AbortController().signal)

	// Titles and captions burn over the finished file in the export (render.ts),
	// not in the region graph — so the exact frame needs that pass too, or an
	// agent checking its title with render_frame sees none.
	const frame = { width: plan.width, height: plan.height }
	const text = cuesAtInstant(cuesForDoc(doc, frame), timeSec)
	if (text.cues.length) {
		const assPath = path.join(dir, `exact-${Date.now()}.ass`)
		fs.writeFileSync(assPath, cuesToAss(text.cues, frame), 'utf-8')
		const burned = outputPath.replace(/\.png$/, '.text.png')
		try {
			// The still loops just long enough to reach the instant, so each cue
			// is exactly as far into its fade as it is in the export.
			const burn = ffmpeg()
				.input(partial)
				.inputOptions(['-loop', '1', '-framerate', String(plan.fps), '-t', (text.at + 2 / plan.fps).toFixed(3)])
				.videoFilters(`subtitles=filename=${escapeSubtitlesPath(assPath)}`)
				.outputOptions(['-ss', text.at.toFixed(3), '-frames:v', '1'])
			await runCommand(burn, burned, new AbortController().signal)
			fs.renameSync(burned, outputPath)
			fs.unlinkSync(partial)
		} catch (error) {
			// The picture without its text beats no picture.
			console.warn('[preview] could not burn text into the exact frame:', error)
		} finally {
			try { fs.unlinkSync(assPath) } catch { /* gone */ }
			if (fs.existsSync(partial)) fs.renameSync(partial, outputPath)
		}
		return { path: outputPath }
	}

	fs.renameSync(partial, outputPath)
	return { path: outputPath }
}
