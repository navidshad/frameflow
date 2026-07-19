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
}

/**
 * EDL playback engine (PRD §5.3): plays the COMPOSED timeline through an
 * A/B pair of <video> elements — one active/visible, one buffering the next
 * segment. Gaps render black and advance on the rAF wall clock. All external
 * seeks arrive via store.seekRequest; scrubbing while playing just re-seeks.
 *
 * Audio scope (M2, honest): only the active video element's own audio plays,
 * gated by item/track mute. Separate audio-track items are silent until M4.
 */
export function useEdlPlayback(videoA: Ref<HTMLVideoElement | null>, videoB: Ref<HTMLVideoElement | null>) {
	const store = useEditorStore()

	const activeIsA = ref(true)
	const inGap = ref(false)
	const currentSegmentId = ref<string | null>(null)

	let rafId: number | null = null
	let lastTick = 0
	let suppressRafRead = false
	let preloadedFor: string | null = null

	const segments = computed<EdlSegment[]>(() => store.videoSegments as EdlSegment[])
	const hasContent = computed(() => segments.value.length > 0)

	const activeEl = () => (activeIsA.value ? videoA.value : videoB.value)
	const bufferEl = () => (activeIsA.value ? videoB.value : videoA.value)

	const segmentAt = (t: number): EdlSegment | null =>
		segments.value.find((s) => t >= s.tStart - 1e-6 && t < s.tEnd - 1e-6) || null

	const nextSegmentAfter = (t: number): EdlSegment | null =>
		segments.value.find((s) => s.tStart >= t - 1e-6) || null

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
			// Gap: black frame, advance on wall clock until the next segment
			inGap.value = true
			activeEl()?.pause()
			currentSegmentId.value = null
			const next = nextSegmentAfter(store.playheadSec)
			if (!next) {
				// Past the last segment: stop at sequence end
				store.isPlaying = false
				store.playheadSec = Math.min(store.playheadSec, store.contentEnd)
				return
			}
			const advanced = store.playheadSec + dt
			if (advanced >= next.tStart) {
				store.playheadSec = next.tStart
				activateAt(next.tStart)
			} else {
				store.playheadSec = advanced
			}
		}
	}

	// ---------- reactions ----------
	watch(() => store.isPlaying, (playing) => {
		if (playing) {
			// Restart from the top if at the very end
			if (store.playheadSec >= store.contentEnd - 0.05 && hasContent.value) {
				store.playheadSec = segments.value[0].tStart
			}
			activateAt(store.playheadSec)
		} else {
			activeEl()?.pause()
		}
	})

	watch(() => store.seekRequest, (req) => {
		suppressRafRead = true
		activateAt(req.time)
	})

	// Timeline edits can change/remove the current segment — re-resolve.
	// Watch a content FINGERPRINT, not array identity: unrelated doc changes
	// (e.g. adding an overlay track) rebuild the computed array every time and
	// must not trigger a needless re-seek/frame jump.
	watch(() => JSON.stringify(segments.value), () => {
		if (!store.isPlaying) activateAt(store.playheadSec)
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
		hasContent,
		currentSegmentId,
		start
	}
}
