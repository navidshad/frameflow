import type { MediaAsset, MediaPreprocessState, PrepLane, PrepLaneRecord, VideoMetadata } from './types'

/**
 * Where a media file's preparation stands, as people and agents should hear it.
 *
 * The document stores `preprocessState: 'running'` while the chain works and
 * keeps it if the app quits mid-chain: nothing resumes the work at launch, so
 * the file would read "running" forever. Main knows which chains are live;
 * a stored 'running' with no live chain is 'interrupted' (Retry in the Media panel).
 */
export type PrepStatus = 'pending' | 'running' | 'interrupted' | 'completed' | 'error'

export function prepStatus(state: MediaAsset['preprocessState'] | undefined, live: boolean): PrepStatus {
	if (state === 'running' && !live) return 'interrupted'
	return state || 'pending'
}

/**
 * Whether the timeline should ask for an asset's filmstrip now. A strip needs
 * only a picture to read frames from (the proxy, or the original once the
 * chain has finished), never the transcript or the scenes: one slow or
 * interrupted step must not leave a clip blank on the timeline. A live chain
 * draws the strip itself right after the proxy, so it is not asked twice.
 */
export function wantsFilmstrip(asset: Pick<MediaAsset, 'kind' | 'preprocessState' | 'proxyPath' | 'filmstrip'>, opts: {
	usedOnTimeline: boolean
	live: boolean
	alreadyRequested: boolean
}): boolean {
	if (asset.kind !== 'video' || !opts.usedOnTimeline || opts.alreadyRequested) return false
	if (asset.filmstrip?.length) return false
	if (opts.live) return false
	return !!asset.proxyPath || asset.preprocessState === 'completed'
}


// ===== Two lanes =====
//
// A video imports as two lanes side by side. WORDS: audio pulled from the
// original, the transcript, the pieces. PICTURE: the proxy, the filmstrip,
// scenes and thumbnails. `preprocessState` is the summary of both; each lane
// keeps its own record so one can fail, pause or finish first.

export const PREP_LANES: PrepLane[] = ['words', 'picture']

export const LANE_LABEL: Record<PrepLane, string> = { words: 'Transcript', picture: 'Proxy and pictures' }

const WORDS_STEPS = new Set(['audio', 'transcript', 'retranscribe'])

/** Which lane a step belongs to. */
export function laneOfStep(step: string): PrepLane {
	return WORDS_STEPS.has(step) ? 'words' : 'picture'
}

/** The lane a named list of steps (Transcribe, Describe, a sensitivity re-run) occupies. */
export function laneOfSteps(steps: readonly string[]): PrepLane {
	return steps.length > 0 && steps.every((s) => WORDS_STEPS.has(s)) ? 'words' : 'picture'
}

type LaneFields = Pick<MediaAsset, 'preprocessState' | 'prepLanes' | 'preprocessError'>

/**
 * One lane's stored record. Media imported before the lanes existed has none:
 * its single state stands for both lanes.
 */
export function laneRecord(asset: LaneFields, lane: PrepLane): PrepLaneRecord | undefined {
	const stored = asset.prepLanes?.[lane]
	if (stored) return stored
	if (asset.prepLanes && (asset.prepLanes.words || asset.prepLanes.picture)) return undefined // the other lane started, this one has not
	switch (asset.preprocessState) {
		case 'running': return { state: 'running' }
		case 'completed': return { state: 'completed' }
		case 'error': return { state: 'error', error: asset.preprocessError }
		default: return undefined
	}
}

/** A lane's status as people and agents hear it: a stored "running" with no live lane is interrupted. */
export function laneStatus(asset: LaneFields, lane: PrepLane, live: boolean): PrepStatus {
	const record = laneRecord(asset, lane)
	if (!record) return 'pending'
	return prepStatus(record.state, live)
}

/**
 * The single flag the rest of the app reads, from the lanes. Running while any
 * lane runs; an error only once nothing is running any more, so a failed
 * picture never hides a transcript that is still on its way (and the other way round).
 */
export function summarizeLanes(lanes: Partial<Record<PrepLane, PrepLaneRecord>>): { state: MediaPreprocessState; error?: string } {
	const records = PREP_LANES.map((l) => lanes[l]).filter((r): r is PrepLaneRecord => !!r)
	if (records.some((r) => r.state === 'running')) return { state: 'running' }
	const failed = records.find((r) => r.state === 'error')
	if (failed) return { state: 'error', error: failed.error }
	return { state: 'completed' }
}

/**
 * The AI (chat and agents) has something to read once the words lane is done
 * and pieces exist. It does not wait for the proxy, scenes or thumbnails.
 */
export function aiReady(asset: Pick<MediaAsset, 'preprocessState' | 'prepLanes' | 'preprocessError' | 'clips'>): boolean {
	return laneRecord(asset, 'words')?.state === 'completed' && (asset.clips?.length ?? 0) > 0
}

// ===== Can the original play as it is? =====

/**
 * Whether the app's own browser plays this file straight from disk, smooth and
 * on the video chip. Measured in Electron 44 on a Mac (docs/import-speed-
 * investigation.md): H.264, HEVC and VP9 in mp4/mov/webm yes; ProRes, MPEG-4
 * part 2 and VVC no; AV1 plays but in software, so it counts as no. A fixed
 * rule rather than a runtime probe, so main, the renderer and the tests all
 * give one answer. HEVC counts only on a Mac: elsewhere it depends on the
 * graphics card, which this cannot see.
 */
export function playsNatively(
	meta: Pick<VideoMetadata, 'codec'> & Partial<Pick<VideoMetadata, 'pixFmt'>> | undefined,
	file: string,
	platform: string = 'darwin'
): boolean {
	if (!meta) return false
	const ext = (file.match(/\.[^./\\]+$/)?.[0] || '').toLowerCase()
	const codec = (meta.codec || '').toLowerCase()
	// 4:2:2 and 4:4:4 are not hardware decoded by the browser.
	if (meta.pixFmt && /422|444/.test(meta.pixFmt)) return false
	if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
		return codec === 'h264' || (codec === 'hevc' && platform === 'darwin')
	}
	if (ext === '.webm') return codec === 'vp9' || codec === 'vp8'
	return false
}

// ===== THE HDR POLICY =====

/**
 * HDR (an iPhone's HLG, or PQ) looks different played straight from the
 * original in the monitor than it exports: from the original it is noticeably
 * more orange (one sample: green -17, blue -23 levels). Only the tagged proxy
 * (ffmpeg/proxyTags.ts) matches the export. This one function is the policy:
 *
 *   true  -> the clip may be placed and played at once, but its colours are
 *            marked "not final" in the Media panel until the proxy exists, and
 *            its proxy jumps ahead of other proxies.
 *   false -> the original is shown as is, nothing is flagged.
 *
 * Navid has not chosen between (a) show the original as is and swap later,
 * (b) this, or (c) tone-map HDR in the export. To pick (a), return false.
 */
export function hdrOriginalNeedsProxy(meta: Pick<VideoMetadata, 'colorTransfer'> | undefined): boolean {
	const transfer = meta?.colorTransfer
	return transfer === 'arib-std-b67' || transfer === 'smpte2084'
}

// ===== What is ready, in plain words =====

export type ChipTone = 'good' | 'busy' | 'warn' | 'bad'
export interface ReadinessChip { text: string; tone: ChipTone }

export interface MediaReadiness {
	/** The clip can be dropped on the timeline (the probe worked and it has a length). */
	placeable: boolean
	/** What the monitor plays: the proxy, the original, or nothing yet (a file the browser cannot play, still waiting for its proxy). */
	playsFrom: 'proxy' | 'original' | 'nothing'
	/** The transcript is done and the pieces exist: the AI can start. */
	aiReady: boolean
	/** False while HDR colours come from the original (see hdrOriginalNeedsProxy). */
	colourFinal: boolean
	/** Every lane is done: nothing is left to say, show the plain piece count instead. */
	settled: boolean
	chips: ReadinessChip[]
}

export function mediaReadiness(
	asset: Pick<MediaAsset, 'kind' | 'originalPath' | 'proxyPath' | 'metadata' | 'preprocessState' | 'preprocessError' | 'prepLanes' | 'clips' | 'preprocessing' | 'transcriptError'>,
	opts: { interrupted?: readonly PrepLane[]; proxyPercent?: number; platform?: string } = {}
): MediaReadiness {
	const interrupted = opts.interrupted ?? []
	const placeable = (asset.metadata?.duration || 0) > 0
	const hasRealProxy = !!asset.proxyPath && asset.proxyPath !== asset.originalPath
	const playsFrom = asset.proxyPath
		? 'proxy'
		: asset.kind === 'video' && playsNatively(asset.metadata, asset.originalPath, opts.platform) ? 'original'
		: asset.kind === 'video' ? 'nothing' : 'original'
	const colourFinal = !(asset.kind === 'video' && hdrOriginalNeedsProxy(asset.metadata) && !hasRealProxy)
	const words = laneStatus(asset, 'words', !interrupted.includes('words'))
	const picture = laneStatus(asset, 'picture', !interrupted.includes('picture'))
	const settled = asset.preprocessState === 'completed' && colourFinal

	const chips: ReadinessChip[] = []
	if (asset.kind !== 'video') return { placeable, playsFrom, aiReady: aiReady(asset), colourFinal, settled, chips }

	if (!placeable) chips.push({ text: 'Reading the file', tone: 'busy' })
	else if (playsFrom === 'nothing') chips.push({ text: 'Can be placed; preview needs the proxy', tone: 'warn' })
	else chips.push({ text: 'Ready to edit', tone: 'good' })

	if (asset.metadata?.hasAudio !== false && placeable) {
		if (words === 'running' || words === 'pending') chips.push({ text: 'Transcript in progress', tone: 'busy' })
		else if (words === 'interrupted') chips.push({ text: 'Transcript paused', tone: 'warn' })
		else if (words === 'error') chips.push({ text: 'Transcript failed', tone: 'bad' })
		else if (asset.preprocessing?.transcriptPath) chips.push({ text: 'Transcript ready', tone: 'good' })
		else if (asset.transcriptError) chips.push({ text: 'No transcript', tone: 'warn' })
	}

	if (picture === 'running' || picture === 'pending') {
		chips.push({
			text: !asset.proxyPath
				? (opts.proxyPercent !== undefined ? `Proxy ${Math.round(opts.proxyPercent)}%` : 'Proxy in progress')
				: 'Thumbnails in progress',
			tone: 'busy'
		})
	} else if (picture === 'interrupted') chips.push({ text: 'Proxy paused', tone: 'warn' })
	else if (picture === 'error') chips.push({ text: 'Proxy failed', tone: 'bad' })

	if (!colourFinal) chips.push({ text: 'Colours not final', tone: 'warn' })

	return { placeable, playsFrom, aiReady: aiReady(asset), colourFinal, settled, chips }
}
