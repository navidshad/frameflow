import type { RenderStepInfo } from '@shared/types'

/**
 * What an export is doing, in steps, and how long it has left.
 *
 * The bar used to be a fixed split (the first 15% for motion layers, then the
 * regions to 96%), which said nothing about time: on a 4K project one percent
 * of the motion stage took minutes while the same percent of another stage took
 * seconds. Here every step carries an estimate of its own duration, the bar is
 * the share of the estimated total that is done, and the time left is measured
 * once a step is under way and estimated before it.
 *
 * Pure (the clock is a parameter), so it is tested without a render.
 */

export interface StepPlan {
	id: string
	label: string
	/** Estimated seconds the step takes. 0 for one that is already done (cached). */
	estSec: number
	/** The estimate before it was scaled by what this machine measured on past exports. Recorded against the real time. */
	rawEstSec?: number
	/** Whether `estSec` has been scaled by this machine's own history. An estimate that has not is a first guess. */
	calibrated?: boolean
}

/** How much to trust the time left: it sets how wide a range is shown. */
export type EtaConfidence = 'low' | 'medium' | 'high'

/** What a finished step really took, for the next export's estimates. */
export interface StepActual {
	id: string
	rawEstSec: number
	actualSec: number
}

interface StepState {
	plan: StepPlan
	state: RenderStepInfo['state']
	fraction: number
	startedAt?: number
	finishedAt?: number
	detail?: string
	/** (time, fraction) points of the running step, for its recent pace. */
	samples: { at: number; fraction: number }[]
}

export interface RenderSnapshot {
	steps: RenderStepInfo[]
	/** 0-100, the share of the estimated total that is done. */
	percent: number
	/** Seconds left, or null before there is anything to base it on. */
	etaSec: number | null
	/** How far the time left may be off, as a share of it (0.3: plus or minus 30%). 0 when there is no estimate. */
	etaSpread: number
	elapsedSec: number
}

/** A step this short still counts for something on the bar. */
const MIN_WEIGHT_SEC = 0.5
/** Measure a step's pace only once it has run this long and got this far; before that, the estimate. */
const MEASURE_AFTER_SEC = 6
const MEASURE_AFTER_FRACTION = 0.03
/** The pace of the last stretch counts too: work rarely goes at one speed (long runs of tiny cuts, then long clips). */
const RECENT_WINDOW_SEC = 120
const RECENT_MIN_SPAN_SEC = 20
/** A pace this far from the whole-step average says the step is not steady. */
const UNSTEADY_RATIO = 1.3
/** Samples are kept at most this often. */
const SAMPLE_EVERY_SEC = 5
/** A step shorter than this is mostly start-up and tells nothing about the rate. */
const MIN_ACTUAL_SEC = 5

/**
 * How wide a range to show around the time left, as a share of it.
 *
 * This is the rule that decides how honest the number looks. The
 * time left is a guess whose error depends on how much of it is measured. 'low'
 * means it is mostly the first-guess table (nothing measured yet, or the steps
 * still to come have never run on this machine); 'medium' means the running step
 * is measured but its pace is changing, or a large part of what is left is still
 * a guess; 'high' means a steady measured pace and little left that is guessed.
 * Return the plus-or-minus share (0.3 shows "about 7 to 13 min" around 10 min).
 * It is shown as a range from 0.1 up, so under that the number stands alone.
 */
export function etaSpreadFor(confidence: EtaConfidence): number {
	return confidence === 'low' ? 0.6 : confidence === 'medium' ? 0.3 : 0.1
}

export class RenderTracker {
	private readonly steps: StepState[]
	private readonly startedAt: number

	constructor(plans: StepPlan[], private readonly now: () => number = Date.now) {
		this.steps = plans.map((plan) => ({ plan, state: 'pending' as const, fraction: 0, samples: [] }))
		this.startedAt = now()
	}

	private find(id: string): StepState | undefined {
		return this.steps.find((s) => s.plan.id === id)
	}

	/** Start a step. Any earlier step left open is finished: steps run in order. */
	begin(id: string, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		for (const earlier of this.steps) {
			if (earlier === step) break
			if (earlier.state !== 'done') { earlier.state = 'done'; earlier.fraction = 1; earlier.finishedAt = this.now() }
		}
		if (step.state === 'pending') { step.state = 'active'; step.startedAt = this.now() }
		if (detail !== undefined) step.detail = detail
	}

	progress(id: string, fraction: number, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		if (step.state === 'pending') this.begin(id)
		if (step.state === 'done') return
		step.fraction = Math.min(1, Math.max(step.fraction, fraction)) // never backwards
		if (detail !== undefined) step.detail = detail
		const at = this.now()
		const last = step.samples[step.samples.length - 1]
		if (!last || at - last.at >= SAMPLE_EVERY_SEC * 1000) {
			step.samples.push({ at, fraction: step.fraction })
			// Only the recent stretch is ever read, so older points are let go.
			while (step.samples.length > 2 && at - step.samples[0].at > RECENT_WINDOW_SEC * 2000) step.samples.shift()
		}
	}

	complete(id: string, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		if (step.state === 'pending') this.begin(id)
		if (step.state !== 'done') step.finishedAt = this.now()
		step.state = 'done'
		step.fraction = 1
		if (detail !== undefined) step.detail = detail
	}

	/** Every step done: the render landed. */
	finishAll(): void {
		for (const step of this.steps) {
			if (step.state !== 'done') step.finishedAt = this.now()
			step.state = 'done'
			step.fraction = 1
		}
	}

	/** What each step that really ran took against its first-guess estimate. A step that was cached or skipped says nothing. */
	actuals(): StepActual[] {
		const out: StepActual[] = []
		for (const s of this.steps) {
			if (s.startedAt === undefined || s.finishedAt === undefined) continue
			const raw = s.plan.rawEstSec ?? s.plan.estSec
			const actualSec = (s.finishedAt - s.startedAt) / 1000
			if (raw <= 0 || actualSec < MIN_ACTUAL_SEC) continue
			out.push({ id: s.plan.id, rawEstSec: raw, actualSec })
		}
		return out
	}

	snapshot(): RenderSnapshot {
		const now = this.now()
		const weight = (s: StepState) => Math.max(s.plan.estSec, MIN_WEIGHT_SEC)
		const total = this.steps.reduce((sum, s) => sum + weight(s), 0) || 1
		const doneWeight = this.steps.reduce((sum, s) => sum + weight(s) * s.fraction, 0)

		let eta = 0
		let guessed = 0 // the part of the time left that is still the first-guess table
		let unsteady = false
		let measuredActive = false
		for (const s of this.steps) {
			if (s.state === 'done') continue
			const remaining = 1 - s.fraction
			const elapsed = s.startedAt === undefined ? 0 : (now - s.startedAt) / 1000
			const measured = s.state === 'active' && elapsed >= MEASURE_AFTER_SEC && s.fraction >= MEASURE_AFTER_FRACTION
			if (measured) {
				measuredActive = true
				const overall = s.fraction / elapsed
				const recent = this.recentRate(s, now)
				// The slower of the two: a step that has slowed down is not going to speed up
				// because its first half was quick.
				const rate = recent === null ? overall : Math.min(overall, recent)
				if (recent !== null && (recent / overall < 1 / UNSTEADY_RATIO || recent / overall > UNSTEADY_RATIO)) unsteady = true
				eta += remaining / rate
			} else {
				const left = s.plan.estSec * remaining
				eta += left
				// A step that is running but not yet measured, or one that has not started, is a guess
				// unless this machine has measured that kind of step before.
				if (!s.plan.calibrated) guessed += left
			}
		}

		const guessedShare = eta > 0 ? guessed / eta : 0
		const confidence: EtaConfidence = !measuredActive || guessedShare > 0.5
			? 'low'
			: unsteady || guessedShare > 0.25 ? 'medium' : 'high'

		return {
			steps: this.steps.map((s) => ({ id: s.plan.id, label: s.plan.label, state: s.state, detail: s.detail })),
			percent: Math.min(100, (doneWeight / total) * 100),
			etaSec: Math.round(eta),
			etaSpread: eta > 0 ? etaSpreadFor(confidence) : 0,
			elapsedSec: Math.round((now - this.startedAt) / 1000)
		}
	}

	/** Fraction per second over the last stretch of a running step, or null when there is not enough of it yet. */
	private recentRate(step: StepState, now: number): number | null {
		const from = step.samples.find((p) => now - p.at <= RECENT_WINDOW_SEC * 1000)
		if (!from) return null
		const span = (now - from.at) / 1000
		const gained = step.fraction - from.fraction
		return span >= RECENT_MIN_SPAN_SEC && gained > 0 ? gained / span : null
	}
}

// ===== Estimates =====
// Measured on an M1 Pro (see the notes beside each); they set the weight of a
// step before it runs and are replaced by the step's own pace once it is going.

const UHD_PIXELS = 3840 * 2160

/**
 * Drawing motion layers: a frame is about 11 ms plus 15 ns a pixel (17 ms at
 * 480p, 137 at 4K), a fifth less with the capture overlapped with the write,
 * and 4K draws two clips at once for a gain of about a fifth where small
 * frames draw four for a gain of about a third.
 */
export const estimateMotionSec = (frames: number, pixels: number): number =>
	(frames * (11 + 1.5e-5 * pixels) * 0.8) / (pixels > 1920 * 1080 ? 1.2 : 3) / 1000

/**
 * Each segment is a process of its own: it starts, finds its place in the source
 * and decodes up to the cut. A first guess; a project of two hundred short cuts
 * is dominated by it, and this machine's history corrects it.
 */
const SEGMENT_START_SEC = 0.5

/** Regions, three at a time on a Mac: about 0.2 s per timeline second at 4K, less at smaller sizes. */
export const estimateRegionsSec = (timelineSec: number, pixels: number, segments = 0): number =>
	timelineSec * (0.08 + 0.12 * Math.min(1, pixels / UHD_PIXELS)) + segments * SEGMENT_START_SEC

/** Stream-copy join of the regions, and the sound encoded once. */
export const estimateJoinSec = (timelineSec: number): number => 2 + timelineSec * 0.005

/** Burning titles and captions re-encodes the file: 2.9 s per 10 s of 4K at x264 veryfast. */
export const estimateBurnSec = (timelineSec: number, pixels: number): number =>
	timelineSec * (0.05 + 0.24 * Math.min(1, pixels / UHD_PIXELS))

/** A pass over the sound only. */
export const estimateLoudnessSec = (timelineSec: number): number => 2 + timelineSec * 0.03

/** A second transcode of the finished picture. */
export const estimateDeliverySec = (timelineSec: number): number => timelineSec * 0.15
