import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { resolvePreviewFrame, seamFingerprint } from '@shared/previewFrame'

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
	videoB: Ref<HTMLVideoElement | null>,
	/** Plays the pre-rendered transition window, when one is cached. */
	videoT: Ref<HTMLVideoElement | null>
) {
	const store = useEditorStore()

	const activeIsA = ref(true)
	const inGap = ref(false)
	/** 0..1 per element, written every tick. NOT a CSS transition: pausing inside
	 *  a window has to hold a correctly blended frame, and a CSS ramp cannot. */
	const opacityA = ref(1)
	const opacityB = ref(0)
	/** True while the cached window is on screen and A/B are hidden. */
	const showCached = ref(false)
	/** A window is blending with the stand-in because its render has not landed. */
	const previewPending = ref(false)
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
			// Compare against the src we LAST SET, never el.src — reading el.src
			// back returns the URL as the parser re-serialised it, which need not
			// be string-equal to what was assigned. A mismatch here would reset
			// .src every frame and reload the element into silence.
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
		el.dataset.edlItem = seg.itemId
		// Compare the url we LAST SET, never el.src — reading it back returns the
		// parser's re-serialisation, which need not be string-equal, so comparing
		// against it can reload the element on every call.
		if (el.dataset.edlSrc !== wantedSrc) {
			el.src = wantedSrc
			el.dataset.edlSrc = wantedSrc
			preloadedFor = null
		}
		el.playbackRate = seg.speed
		el.muted = seg.muted
		const target = sourceTime(t, seg)
		if (Math.abs(el.currentTime - target) > 0.08) {
			el.currentTime = target
		}
	}

	// ===== Transition windows =====

	/**
	 * Apply the transition state for time `t` to the elements.
	 *
	 * Called from the rAF loop AND from every seek/pause path, because `tick`
	 * returns early while paused — a window has to hold its blended frame when
	 * you stop inside it, not snap back to one clip.
	 */
	const applyWindow = (t: number): boolean => {
		const frame = resolvePreviewFrame(
			store.seams, store.transitionPreviews, t, store.playableItemIds
		)
		previewPending.value = frame.pending

		if (frame.mode === 'single') {
			showCached.value = false
			opacityA.value = activeIsA.value ? 1 : 0
			opacityB.value = activeIsA.value ? 0 : 1
			// Undo what the window did to these elements. Leaving the ramp or the
			// mute in place means the clip AFTER a transition plays quiet or silent;
			// leaving the window marker means re-entering it never re-seeks.
			for (const el of [videoA.value, videoB.value]) {
				if (!el) continue
				if (el.volume !== 1) el.volume = 1
				const leftWindow = !!el.dataset.edlWindow
				delete el.dataset.edlWindow
				const seg = segments.value.find((sg) => sg.itemId === el.dataset.edlItem)
				if (!seg) continue
				if (el.muted !== seg.muted) el.muted = seg.muted
				// One-time handover: align the element that is about to become the
				// clock to where the playhead actually is. Through the window the
				// playhead ran on the wall clock while the element ran on its own,
				// so they have drifted, and the next frame reads the element.
				if (leftWindow && el === activeEl()) {
					const target = sourceTime(t, seg)
					if (Math.abs(el.currentTime - target) > 0.08) el.currentTime = target
				}
				// Outside a window exactly ONE element is on screen, so exactly one
				// may be making sound. A window deliberately keeps both rolling so the
				// handover is seamless — but if the outgoing clip is not stopped the
				// moment the window ends it plays on underneath the next one, and you
				// hear both at once. The ordinary A/B swap pauses it; a window skips
				// that path entirely, so it has to happen here.
				if (el !== activeEl() && !el.paused) el.pause()
			}
			const cached = videoT.value
			if (cached && !cached.paused) cached.pause()
			return false
		}

		// Both source elements are positioned and rolling for EITHER mode. The
		// cached file just covers them — keeping them live underneath means
		// leaving the window is a handover, not a seek, which is what made the
		// exit stutter.
		const w = frame.window!
		const elFor = (itemId: string) =>
			[videoA.value, videoB.value].find((el) => el?.dataset.edlItem === itemId) || null
		let outEl = elFor(w.outgoing.item.id)
		let inEl = elFor(w.incoming.item.id)
		const other = (el: HTMLVideoElement | null) => (el === videoA.value ? videoB.value : videoA.value)
		if (!outEl && !inEl) { outEl = activeEl(); inEl = bufferEl() }
		else if (!inEl) inEl = other(outEl)
		else if (!outEl) outEl = other(inEl)
		if (!outEl || !inEl || outEl === inEl) return true

		const cachedShowing = frame.mode === 'cached'

		/** Each side's `in` is its SOURCE time at the window's start, already
		 *  speed-corrected and already reaching into the handle where there is one. */
		const place = (el: HTMLVideoElement, side: typeof w.outgoing) => {
			const seg = segments.value.find((sg) => sg.itemId === side.item.id)
			if (!seg) return
			const entering = el.dataset.edlWindow !== w.junctionId
			el.dataset.edlItem = side.item.id
			el.dataset.edlWindow = w.junctionId
			if (el.dataset.edlSrc !== seg.src) { el.src = seg.src; el.dataset.edlSrc = seg.src }
			el.playbackRate = seg.speed
			const target = Math.min(side.out, side.in + (t - w.start) * seg.speed)
			// Hard-seek only on ENTRY, then let it free-run. Re-seeking a playing
			// element every time it drifts a frame is itself the judder — the audio
			// pool learned the same lesson and only corrects on a large gap.
			if (entering || Math.abs(el.currentTime - target) > 0.5) {
				el.currentTime = Math.max(0, target)
			}
			// The cached file carries the crossfaded audio, so silence the sources
			// under it. Otherwise they are the audio, at equal power.
			if (cachedShowing || seg.muted) {
				el.muted = true
			} else {
				el.muted = false
				const ramp = side.item.id === w.outgoing.item.id
					? Math.cos((frame.progress * Math.PI) / 2)
					: Math.sin((frame.progress * Math.PI) / 2)
				el.volume = Math.max(0, Math.min(1, ramp))
			}
			if (store.isPlaying) { if (el.paused) el.play().catch(() => { }) }
			else if (!el.paused) el.pause()
		}
		place(outEl, w.outgoing)
		place(inEl, w.incoming)

		const aIsOutgoing = outEl === videoA.value
		if (cachedShowing) {
			showCached.value = true
			opacityA.value = 0
			opacityB.value = 0
			const cached = videoT.value
			if (cached) {
				if (cached.dataset.edlSrc !== frame.cachedSrc) {
					cached.src = frame.cachedSrc!
					cached.dataset.edlSrc = frame.cachedSrc!
				}
				const target = frame.cachedTime ?? 0
				if (Math.abs(cached.currentTime - target) > 0.3) cached.currentTime = Math.max(0, target)
				if (store.isPlaying) { if (cached.paused) cached.play().catch(() => { }) }
				else if (!cached.paused) cached.pause()
			}
		} else {
			showCached.value = false
			const cached = videoT.value
			if (cached && !cached.paused) cached.pause()
			opacityA.value = aIsOutgoing ? 1 - frame.progress : frame.progress
			opacityB.value = aIsOutgoing ? frame.progress : 1 - frame.progress
		}

		// The window owns the handover, so leave activeIsA pointing at whichever
		// element carries the INCOMING clip — that is what plays on after the end.
		activeIsA.value = !aIsOutgoing
		currentSegmentId.value = w.incoming.item.id
		return true
	}

	/** Activate the segment covering time t on the active element. */
	const activateAt = (t: number) => {
		const seg = segmentAt(t)
		inGap.value = !seg
		// Seeking into a window has to set up BOTH elements, not one.
		if (seg && applyWindow(t)) return
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

	/**
	 * Prime the buffer element with the next segment's source.
	 *
	 * The lead has to clear the longest window: a transition starts BEFORE the
	 * cut, so a 5s one needs the incoming clip ready 2.5s early — the old flat
	 * 1.5s meant a long window began against an unprimed element. And when a
	 * window is coming, the buffer seeks into the incoming clip's HEAD HANDLE
	 * (earlier than its in-point), which is the footage the blend actually shows.
	 */
	const maybePreload = (t: number) => {
		const seg = segmentAt(t)
		if (!seg) return
		const upcoming = store.seams.find((s) => s.window && s.window.start > t && s.window.start - t < 6)
		const lead = Math.max(1.5, (upcoming?.window?.duration ?? 0) / 2 + 1)
		if (seg.tEnd - t > lead) return
		const next = nextSegmentAfter(seg.tEnd)
		if (!next || next.itemId === seg.itemId || preloadedFor === next.itemId) return
		const buf = bufferEl()
		if (!buf) return
		const window = upcoming?.window
		const startsEarlyAt = window && window.incoming.item.id === next.itemId
			? window.incoming.in
			: next.sourceIn
		// Only touch `src` when it actually changes. Reassigning the SAME url tears
		// the decoder down and reloads the file — and a timeline cut from one long
		// source hits that on every single switch, which is most of the stutter.
		if (buf.dataset.edlSrc !== next.src) {
			buf.src = next.src
			buf.dataset.edlSrc = next.src
		}
		buf.playbackRate = next.speed
		buf.muted = next.muted
		buf.currentTime = Math.max(0, startsEarlyAt)
		buf.pause()
		preloadedFor = next.itemId

		// Prime the cached transition too, so entering the window is not the first
		// time that file is fetched and decoded.
		const cached = videoT.value
		const ready = upcoming && store.transitionPreviews.get(upcoming.junction.id)
		if (cached && ready?.status === 'ready' && ready.src && cached.dataset.edlSrc !== ready.src) {
			cached.src = ready.src
			cached.dataset.edlSrc = ready.src
			cached.currentTime = 0
			cached.pause()
		}
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
			// Inside a transition the window drives both elements; the ordinary
			// one-element swap would pause the outgoing clip mid-blend.
			if (applyWindow(store.playheadSec)) {
				// Wall clock, not media time: inside a window neither element is
				// authoritative, and there is nothing to preload — `bufferEl()` is
				// the OUTGOING clip mid-blend, and priming it would seek and pause
				// the very picture being shown.
				store.playheadSec = Math.min(store.contentEnd, store.playheadSec + dt)
				return
			}
			if (currentSegmentId.value !== seg.itemId) {
				activateAt(store.playheadSec)
				return
			}
			if (el.paused) el.play().catch(() => { })
			if (!suppressRafRead) {
				// Derive the playhead from real media time (drift-free). Never let it
				// run BACKWARDS: a decoder that is momentarily behind would otherwise
				// pull the playhead back inside a window we just left, which re-enters
				// it, advances to the end again, and loops there forever — holding the
				// last frame and replaying the same fragment of sound.
				const derived = seg.tStart + (el.currentTime - seg.sourceIn) / seg.speed
				if (derived > store.playheadSec) store.playheadSec = derived
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
	watch(() => store.playheadSec, (t) => {
		syncAudio(t, false)
		// `tick` returns early while paused, so scrubbing through a window would
		// otherwise freeze on whatever blend the last playing frame left behind.
		if (!store.isPlaying) applyWindow(t)
	})

	// A transition is invisible to the segment fingerprint below — the EDL carries
	// nothing about them — so watch the resolved windows separately or dropping one
	// in would never reach the monitor until some unrelated edit forced a re-resolve.
	watch(() => seamFingerprint(store.seams), () => {
		applyWindow(store.playheadSec)
		if (!store.isPlaying) activateAt(store.playheadSec)
	})

	// A render starting or landing changes what the monitor should show, and
	// nothing else re-evaluates: `tick` only runs while playing and the playhead
	// watcher only fires when it moves. Without this the "preparing" hint never
	// appeared and the finished render only swapped in once you happened to scrub.
	watch(() => store.transitionPreviews, () => applyWindow(store.playheadSec))

	watch(() => store.isPlaying, (playing) => {
		if (playing) {
			// Restart from the top if at the very end
			if (store.playheadSec >= store.contentEnd - 0.05 && hasContent.value) {
				store.playheadSec = firstStart()
			}
			activateAt(store.playheadSec)
		} else {
			activeEl()?.pause()
			// A window has BOTH source elements running, plus possibly the cached
			// one — pausing only the active element would leave the others rolling.
			bufferEl()?.pause()
			videoT.value?.pause()
		}
		applyWindow(store.playheadSec)
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
		videoT.value?.pause()
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
		opacityA,
		opacityB,
		showCached,
		previewPending,
		start
	}
}
