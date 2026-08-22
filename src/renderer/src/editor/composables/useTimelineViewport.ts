import { computed, nextTick, ref, type InjectionKey, type Ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

/**
 * Viewport math for the purpose-built timeline: px <-> seconds, scroll
 * tracking, window-mounting range, and cursor-anchored zoom.
 * Instantiated ONCE by TimelinePanel and provided to lanes/ruler/clips.
 */
export function useTimelineViewport() {
	const store = useEditorStore()

	const scrollEl = ref<HTMLElement | null>(null)
	const scrollLeft = ref(0)
	const clientWidth = ref(0)

	const MIN_PX_PER_SEC = 4
	const MAX_PX_PER_SEC = 400
	const VISIBLE_MARGIN_SEC = 5

	const secToPx = (s: number) => s * store.pxPerSecond
	const pxToSec = (p: number) => p / store.pxPerSecond

	/** Total content width: sequence end + tail head-room for appending. */
	const contentWidth = computed(() => secToPx(store.contentEnd + store.timelineTail))

	/** Seconds range currently visible (with margin) — drives window-mounting. */
	const visibleRange = computed<[number, number]>(() => [
		pxToSec(scrollLeft.value) - VISIBLE_MARGIN_SEC,
		pxToSec(scrollLeft.value + clientWidth.value) + VISIBLE_MARGIN_SEC
	])

	const intersectsVisible = (startSec: number, endSec: number) =>
		endSec >= visibleRange.value[0] && startSec <= visibleRange.value[1]

	const onScroll = () => {
		if (!scrollEl.value) return
		scrollLeft.value = scrollEl.value.scrollLeft
		clientWidth.value = scrollEl.value.clientWidth
	}

	// The timeline's width changes without scrolling (panel full-height toggles,
	// width/height drag handles) — observe the element so clientWidth and the
	// window-mounting range stay fresh.
	let resizeObserver: ResizeObserver | null = null

	const setScrollEl = (el: HTMLElement | null) => {
		resizeObserver?.disconnect()
		scrollEl.value = el
		onScroll()
		if (el && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => onScroll())
			resizeObserver.observe(el)
		} else {
			resizeObserver = null
		}
	}

	const clampZoom = (v: number) => Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, v))

	/** Zoom keeping the time under the cursor fixed in place. */
	const zoomAtCursor = async (e: WheelEvent) => {
		const el = scrollEl.value
		if (!el) return
		const rect = el.getBoundingClientRect()
		const offsetX = e.clientX - rect.left
		const cursorTime = pxToSec(el.scrollLeft + offsetX)
		store.pxPerSecond = clampZoom(store.pxPerSecond * Math.exp(-e.deltaY * 0.002))
		await nextTick() // content width updates first
		el.scrollLeft = cursorTime * store.pxPerSecond - offsetX
		onScroll()
	}

	/** Zoom by a factor, anchored at the viewport center. */
	const zoomBy = async (factor: number) => {
		const el = scrollEl.value
		if (!el) return
		const centerTime = pxToSec(el.scrollLeft + el.clientWidth / 2)
		store.pxPerSecond = clampZoom(store.pxPerSecond * factor)
		await nextTick()
		el.scrollLeft = centerTime * store.pxPerSecond - el.clientWidth / 2
		onScroll()
	}

	const fitToWindow = async () => {
		const el = scrollEl.value
		if (!el) return
		store.pxPerSecond = clampZoom(el.clientWidth / Math.max(store.contentEnd, 1))
		await nextTick()
		el.scrollLeft = 0
		onScroll()
	}

	const fitToSelection = async () => {
		const el = scrollEl.value
		const items = store.selectedItems
		if (!el || !items.length) return
		const minStart = Math.min(...items.map((i) => i.timelineStart))
		const maxEnd = Math.max(...items.map((i) => i.timelineStart + i.duration))
		const span = Math.max(maxEnd - minStart, 0.5)
		store.pxPerSecond = clampZoom((el.clientWidth * 0.9) / span)
		await nextTick()
		el.scrollLeft = minStart * store.pxPerSecond - el.clientWidth * 0.05
		onScroll()
	}

	const scrollToTime = (t: number) => {
		const el = scrollEl.value
		if (!el) return
		const px = secToPx(t)
		if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth) {
			el.scrollLeft = Math.max(0, px - el.clientWidth / 3)
			onScroll()
		}
	}

	return {
		scrollEl,
		scrollLeft,
		clientWidth,
		secToPx,
		pxToSec,
		contentWidth,
		visibleRange,
		intersectsVisible,
		setScrollEl,
		onScroll,
		zoomAtCursor,
		zoomBy,
		fitToWindow,
		fitToSelection,
		scrollToTime
	}
}

export type TimelineViewport = ReturnType<typeof useTimelineViewport>
export const TimelineViewportKey: InjectionKey<TimelineViewport> = Symbol('timeline-viewport')
export const TimelineInteractionsKey: InjectionKey<any> = Symbol('timeline-interactions')

/** Convenience for template width/left styles. */
export const px = (n: number) => `${n}px`

export type MaybeElement = Ref<HTMLElement | null>
