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
}

/**
 * EDL playback engine (PRD §5.3): plays the COMPOSED timeline through an
 * A/B pair of <video> elements — one active/visible, one buffering the next
 * segment. Gaps render black and advance on the rAF wall clock. All external
 * seeks arrive via store.seekRequest; scrubbing while playing just re-seeks.
 *
 * Audio-track items (audio-kind assets on A-lanes) play through a separate
 * <audio> element slaved to the playhead: the video EDL remains the master
 * clock, and each tick/seek positions the audio element to match. Overlapping
 * audio tracks are a preview approximation (one plays); export mixes them (§5.9).
 */
export function useEdlPlayback(
	videoA: Ref<HTMLVideoElement | null>,
	videoB: Ref<HTMLVideoElement | null>,
	audio?: Ref<HTMLAudioElement | null>
) {
	const store = useEditorStore()

	const activeIsA = ref(true)
	const inGap = ref(false)
	const currentSegmentId = ref<string | null>(null)
	const audioActive = ref(false)

	let rafId: number | null = null
	let lastTick = 0
	let suppressRafRead = false
	let preloadedFor: string | null = null

	const segments = computed<EdlSegment[]>(() => store.videoSegments as EdlSegment[])
	const audioSegments = computed<EdlSegment[]>(() => store.audioSegments as EdlSegment[])
	const hasContent = computed(() => segments.value.length > 0 || audioSegments.value.length > 0)

	const audioSegAt = (t: number): EdlSegment | null =>
		audioSegments.value.find((s) => t >= s.tStart - 1e-6 && t < s.tEnd - 1e-6) || null

	/**
	 * Position the standalone <audio> element to match the playhead. Called on
	 * every tick and after seeks; seeks the element only when drift exceeds a
	 * threshold so playback isn't stuttered by constant re-seeking.
	 */
	const syncAudio = (t: number) => {
		const el = audio?.value
		if (!el) return
		const seg = audioSegAt(t)
		if (!seg || seg.muted) {
			audioActive.value = false
			if (!el.paused) el.pause()
			return
		}
		audioActive.value = true
		const wantedSrc = seg.src
		if (el.src !== wantedSrc) el.src = wantedSrc
		el.playbackRate = seg.speed
		el.volume = Math.max(0, Math.min(1, seg.gain ?? 1))
		const target = seg.sourceIn + (t - seg.tStart) * seg.speed
		if (Math.abs(el.currentTime - target) > 0.15) el.currentTime = target
		if (store.isPlaying) {
			if (el.paused) el.play().catch(() => { })
		} else if (!el.paused) {
			el.pause()
		}
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
	// Audio-track playback is slaved to the playhead: any playhead change
	// (playback frame, scrub, or seek) re-positions the standalone <audio>.
	watch(() => store.playheadSec, (t) => syncAudio(t))

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
		syncAudio(store.playheadSec)
	})

	watch(() => store.seekRequest, (req) => {
		suppressRafRead = true
		activateAt(req.time)
		syncAudio(req.time)
	})

	// Timeline edits can change/remove the current segment — re-resolve.
	// Watch a content FINGERPRINT, not array identity: unrelated doc changes
	// (e.g. adding an overlay track) rebuild the computed array every time and
	// must not trigger a needless re-seek/frame jump.
	watch(() => JSON.stringify(segments.value) + '|' + JSON.stringify(audioSegments.value), () => {
		if (!store.isPlaying) {
			activateAt(store.playheadSec)
			syncAudio(store.playheadSec)
		}
	})

	const start = () => {
		lastTick = performance.now()
		rafId = requestAnimationFrame(tick)
		activateAt(store.playheadSec)
	}

	onUnmounted(() => {
		if (rafId !== null) cancelAnimationFrame(rafId)
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
