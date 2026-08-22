import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

interface EdlSegment {
	itemId: string
	tStart: number
	tEnd: number
	src: string
	sourceIn: number
	speed: number
	muted: boolean
	gain?: number
	fadeInSec?: number
	fadeOutSec?: number
	trackId?: string
}

/** Linear fade envelope at timeline time t — the preview mirror of the export's `fadeA` builder. */
const fadeEnvelope = (seg: EdlSegment, t: number): number => {
	const fadeIn = seg.fadeInSec ?? 0
	const fadeOut = seg.fadeOutSec ?? 0
	let env = 1
	if (fadeIn > 0) env = Math.min(env, (t - seg.tStart) / fadeIn)
	if (fadeOut > 0) env = Math.min(env, (seg.tEnd - t) / fadeOut)
	return Math.max(0, Math.min(1, env))
}

/**
 * EDL playback engine (PRD §5.3): plays the COMPOSED timeline through an
 * A/B pair of <video> elements — one active/visible, one buffering the next
 * segment. Gaps render black and advance on the rAF wall clock. All external
 * seeks arrive via store.seekRequest; scrubbing while playing just re-seeks.
 *
 * Audio tracks play through a POOL of <audio> elements — one per audio track,
 * created on demand — each slaved to the playhead. This lets every audio track
 * sound in parallel with the video (which carries its own soundtrack), matching
 * the multi-source amix that export produces (§5.9). The video EDL stays the
 * master clock; each tick/seek repositions every audio element to match.
 */
export function useEdlPlayback(
	videoA: Ref<HTMLVideoElement | null>,
	videoB: Ref<HTMLVideoElement | null>
) {
	const store = useEditorStore()

	const activeIsA = ref(true)
	const inGap = ref(false)
	const currentSegmentId = ref<string | null>(null)
	const audioActive = ref(false)

	// One <audio> element per audio track, created lazily. Attached to the DOM
	// (hidden) rather than a bare `new Audio()` — Chromium plays in-document
	// media more reliably and it keeps them inspectable.
	const audioEls = new Map<string, HTMLAudioElement>()
	const getAudioEl = (trackId: string): HTMLAudioElement => {
		let el = audioEls.get(trackId)
		if (!el) {
			el = document.createElement('audio')
			el.preload = 'auto'
			el.dataset.edlAudioTrack = trackId
			el.style.display = 'none'
			document.body.appendChild(el)
			audioEls.set(trackId, el)
		}
		return el
	}

	let rafId: number | null = null
	let lastTick = 0
	let suppressRafRead = false
	let preloadedFor: string | null = null

	const segments = computed<EdlSegment[]>(() => store.videoSegments as EdlSegment[])
	const audioSegments = computed<EdlSegment[]>(() => store.audioSegments as EdlSegment[])
	const hasContent = computed(() => segments.value.length > 0 || audioSegments.value.length > 0)

	// Audio segments grouped by track — each track drives its own element.
	const audioByTrack = computed<Map<string, EdlSegment[]>>(() => {
		const m = new Map<string, EdlSegment[]>()
		for (const s of audioSegments.value) {
			const key = s.trackId || '_'
			if (!m.has(key)) m.set(key, [])
			m.get(key)!.push(s)
		}
		return m
	})

	// Which audio item each track element is currently locked onto. A track's
	// element free-runs once started; we only hard-seek it on (re)entry to a
	// segment, an explicit seek, or a large drift — NOT every frame, or the
	// decoder never gets to play smoothly (it just stutters out "beats").
	const activeAudioSeg = new Map<string, string>()
	const AUDIO_DRIFT_HARD = 0.5

	/**
	 * Reposition every audio-track element for playhead `t`. Each track plays its
	 * covering segment in parallel with the video; a track with no segment (or
	 * muted) pauses. `force` re-seeks the element (segment change / explicit seek);
	 * otherwise the element free-runs and is only nudged on large drift.
	 */
	const syncAudio = (t: number, force = false) => {
		let anyActive = false
		const seen = new Set<string>()
		for (const [trackId, segs] of audioByTrack.value) {
			seen.add(trackId)
			const el = getAudioEl(trackId)
			const seg = segs.find((s) => t >= s.tStart - 1e-6 && t < s.tEnd - 1e-6)
			if (!seg || seg.muted) {
				activeAudioSeg.delete(trackId)
				if (!el.paused) el.pause()
				continue
			}
			anyActive = true
			const changed = activeAudioSeg.get(trackId) !== seg.itemId
			// Compare against the src we LAST SET (raw), never el.src — reading
			// el.src back returns a normalized/encoded URL (media:///Users →
			// media://users, %20 for spaces) that never equals seg.src, which
			// would reset .src every frame and reload the element into silence.
			if (el.dataset.edlSrc !== seg.src) {
				el.src = seg.src
				el.dataset.edlSrc = seg.src
			}
			el.playbackRate = seg.speed
			// Gain × fade envelope, re-evaluated every tick so ramps are smooth.
			el.volume = Math.max(0, Math.min(1, (seg.gain ?? 1) * fadeEnvelope(seg, t)))
			const target = seg.sourceIn + (t - seg.tStart) * seg.speed
			if (changed || force || Math.abs(el.currentTime - target) > AUDIO_DRIFT_HARD) {
				el.currentTime = target
			}
			activeAudioSeg.set(trackId, seg.itemId)
			if (store.isPlaying) {
				if (el.paused) el.play().catch(() => { })
			} else if (!el.paused) {
				el.pause()
			}
		}
		// Pause elements whose track is gone (deleted/hidden this frame).
		for (const [trackId, el] of audioEls) {
			if (!seen.has(trackId)) {
				activeAudioSeg.delete(trackId)
				if (!el.paused) el.pause()
			}
		}
		audioActive.value = anyActive
	}

	const activeEl = () => (activeIsA.value ? videoA.value : videoB.value)
	const bufferEl = () => (activeIsA.value ? videoB.value : videoA.value)

	const segmentAt = (t: number): EdlSegment | null =>
		segments.value.find((s) => t >= s.tStart - 1e-6 && t < s.tEnd - 1e-6) || null

	const nextSegmentAfter = (t: number): EdlSegment | null =>
		segments.value.find((s) => s.tStart >= t - 1e-6) || null

	/** Earliest start across video + audio segments (content may be audio-only). */
	const firstStart = (): number => {
		const starts = [...segments.value, ...audioSegments.value].map((s) => s.tStart)
		return starts.length ? Math.min(...starts) : 0
	}

	const sourceTime = (t: number, seg: EdlSegment) =>
		seg.sourceIn + (t - seg.tStart) * seg.speed

	const applySegmentToEl = (el: HTMLVideoElement, seg: EdlSegment, t: number) => {
		const wantedSrc = seg.src
		if (el.src !== wantedSrc) {
			el.src = wantedSrc
			preloadedFor = null
		}
		el.playbackRate = seg.speed
		el.muted = seg.muted
		const target = sourceTime(t, seg)
		if (Math.abs(el.currentTime - target) > 0.08) {
			el.currentTime = target
		}
	}

	/** Activate the segment covering time t on the active element. */
	const activateAt = (t: number) => {
		const seg = segmentAt(t)
		inGap.value = !seg
		if (!seg) {
			currentSegmentId.value = null
			activeEl()?.pause()
			return
		}
		const el = activeEl()
		if (!el) return

		// If the buffer element was preloaded for this segment, swap instead
		if (currentSegmentId.value !== seg.itemId) {
			const buf = bufferEl()
			if (buf && preloadedFor === seg.itemId) {
				activeIsA.value = !activeIsA.value
				el.pause()
				preloadedFor = null
				applySegmentToEl(buf, seg, t)
				currentSegmentId.value = seg.itemId
				if (store.isPlaying) buf.play().catch(() => { })
				return
			}
		}

		applySegmentToEl(el, seg, t)
		currentSegmentId.value = seg.itemId
		if (store.isPlaying && el.paused) el.play().catch(() => { })
	}

	/** Prime the buffer element with the next segment's source. */
	const maybePreload = (t: number) => {
		const seg = segmentAt(t)
		if (!seg) return
		if (seg.tEnd - t > 1.5) return
		const next = nextSegmentAfter(seg.tEnd)
		if (!next || next.itemId === seg.itemId || preloadedFor === next.itemId) return
		const buf = bufferEl()
		if (!buf) return
		buf.src = next.src
		buf.playbackRate = next.speed
		buf.muted = next.muted
		buf.currentTime = next.sourceIn
		buf.pause()
		preloadedFor = next.itemId
	}

	// ---------- rAF loop ----------
	const tick = (now: number) => {
		rafId = requestAnimationFrame(tick)
		const dt = (now - lastTick) / 1000
		lastTick = now
		if (!store.isPlaying) return

		const seg = segmentAt(store.playheadSec)
		if (seg) {
			inGap.value = false
			const el = activeEl()
			if (!el) return
			if (currentSegmentId.value !== seg.itemId) {
				activateAt(store.playheadSec)
				return
			}
			if (el.paused) el.play().catch(() => { })
			if (!suppressRafRead) {
				// Derive the playhead from real media time (drift-free)
				store.playheadSec = seg.tStart + (el.currentTime - seg.sourceIn) / seg.speed
			}
			suppressRafRead = false
			// Crossed the segment end?
			if (store.playheadSec >= seg.tEnd - 0.02) {
				store.playheadSec = seg.tEnd
				activateAt(seg.tEnd + 1e-3)
			}
			maybePreload(store.playheadSec)
		} else {
			// No video at the playhead: advance on the wall clock (audio-track
			// items, if any, are heard via the slaved <audio> element). Black
			// frame until a video segment begins; stop at the sequence end.
			inGap.value = true
			activeEl()?.pause()
			currentSegmentId.value = null
			if (store.playheadSec >= store.contentEnd - 1e-3) {
				store.isPlaying = false
				store.playheadSec = store.contentEnd
				return
			}
			const advanced = Math.min(store.playheadSec + dt, store.contentEnd)
			store.playheadSec = advanced
			// Entered a video segment? make it active.
			if (segmentAt(advanced)) activateAt(advanced)
		}
	}

	// ---------- reactions ----------
	// Audio elements free-run during playback: a plain playhead advance must NOT
	// re-seek them (that stutters the decoder). Only align on segment entry or a
	// real drift — handled inside syncAudio with force=false.
	watch(() => store.playheadSec, (t) => syncAudio(t, false))

	watch(() => store.isPlaying, (playing) => {
		if (playing) {
			// Restart from the top if at the very end
			if (store.playheadSec >= store.contentEnd - 0.05 && hasContent.value) {
				store.playheadSec = firstStart()
			}
			activateAt(store.playheadSec)
		} else {
			activeEl()?.pause()
		}
		// Force-anchor audio to the playhead on play/pause transitions.
		syncAudio(store.playheadSec, true)
	})

	watch(() => store.seekRequest, (req) => {
		suppressRafRead = true
		activateAt(req.time)
		syncAudio(req.time, true) // explicit seek: re-anchor audio
	})

	// Timeline edits can change/remove the current segment — re-resolve.
	// Watch a content FINGERPRINT, not array identity: unrelated doc changes
	// (e.g. adding an overlay track) rebuild the computed array every time and
	// must not trigger a needless re-seek/frame jump.
	watch(() => JSON.stringify(segments.value) + '|' + JSON.stringify(audioSegments.value), () => {
		if (!store.isPlaying) {
			activateAt(store.playheadSec)
			syncAudio(store.playheadSec, true)
		}
	})

	const start = () => {
		lastTick = performance.now()
		rafId = requestAnimationFrame(tick)
		activateAt(store.playheadSec)
	}

	onUnmounted(() => {
		if (rafId !== null) cancelAnimationFrame(rafId)
		for (const el of audioEls.values()) {
			el.pause()
			el.src = ''
			el.remove()
		}
		audioEls.clear()
	})

	return {
		activeIsA,
		inGap,
		audioActive,
		hasContent,
		currentSegmentId,
		start
	}
}
