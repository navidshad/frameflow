/**
 * The transition presets FFmpeg's `xfade` filter ships with.
 *
 * Pure data — no Node/Electron imports. Shared because BOTH sides need it: the
 * renderer lists it in the library panel, and the planner validates against it
 * so an unknown `kind` degrades to a plain cut at plan time instead of failing
 * halfway through a render with an ffmpeg parse error.
 *
 * These 58 names are what `ffmpeg -h filter=xfade` reports for the bundled
 * 9.0.1 build (`vendor/ffmpeg`), minus `custom`, which needs an expression
 * rather than a name. `renderPipeline.test.ts` re-reads that list from the real
 * binary and fails if this file drifts from it.
 *
 * The library is given away whole. The paid tier is ~20 AUTHORED presets
 * (ROADMAP Phase 2) — designed looks with their own parameters — which is a
 * different product from the raw built-ins listed here.
 */

export type TransitionGroup = 'featured' | 'blend' | 'wipe' | 'slide' | 'shape' | 'motion'

export interface TransitionPreset {
	/** The `xfade=transition=` name. Persisted in `TimelineItem.transition`. */
	kind: string
	label: string
	group: TransitionGroup
	/** Tabler icon suffix — the panel renders `iconify tabler--${icon}`. */
	icon: string
}

/**
 * The three surfaced first: one blend, one directional, one with energy, so the
 * top of the list reads as a range rather than three variations on a fade.
 */
export const FEATURED_KINDS = ['fade', 'slideleft', 'zoomin'] as const

export const TRANSITION_GROUP_LABELS: Record<TransitionGroup, string> = {
	featured: 'Featured',
	blend: 'Blends',
	wipe: 'Wipes',
	slide: 'Slides',
	shape: 'Shapes',
	motion: 'Motion'
}

/** Featured first; the rest grouped, so the panel can render headings in order. */
export const TRANSITION_PRESETS: readonly TransitionPreset[] = [
	{ kind: 'fade', label: 'Cross Dissolve', group: 'featured', icon: 'contrast' },
	{ kind: 'slideleft', label: 'Slide Left', group: 'featured', icon: 'arrow-left' },
	{ kind: 'zoomin', label: 'Zoom In', group: 'featured', icon: 'zoom-in' },

	{ kind: 'dissolve', label: 'Grain Dissolve', group: 'blend', icon: 'grain' },
	{ kind: 'fadeblack', label: 'Fade to Black', group: 'blend', icon: 'circle-filled' },
	{ kind: 'fadewhite', label: 'Fade to White', group: 'blend', icon: 'circle' },
	{ kind: 'fadegrays', label: 'Fade to Grey', group: 'blend', icon: 'circle-half' },
	{ kind: 'fadefast', label: 'Fast Fade', group: 'blend', icon: 'player-track-next' },
	{ kind: 'fadeslow', label: 'Slow Fade', group: 'blend', icon: 'player-track-prev' },
	{ kind: 'distance', label: 'Distance', group: 'blend', icon: 'focus-centered' },
	{ kind: 'hblur', label: 'Blur', group: 'blend', icon: 'blur' },
	{ kind: 'pixelize', label: 'Pixelize', group: 'blend', icon: 'grid-dots' },
	{ kind: 'radial', label: 'Radial', group: 'blend', icon: 'radar' },

	{ kind: 'wipeleft', label: 'Wipe Left', group: 'wipe', icon: 'arrow-left' },
	{ kind: 'wiperight', label: 'Wipe Right', group: 'wipe', icon: 'arrow-right' },
	{ kind: 'wipeup', label: 'Wipe Up', group: 'wipe', icon: 'arrow-up' },
	{ kind: 'wipedown', label: 'Wipe Down', group: 'wipe', icon: 'arrow-down' },
	{ kind: 'wipetl', label: 'Wipe Top Left', group: 'wipe', icon: 'arrow-up-left' },
	{ kind: 'wipetr', label: 'Wipe Top Right', group: 'wipe', icon: 'arrow-up-right' },
	{ kind: 'wipebl', label: 'Wipe Bottom Left', group: 'wipe', icon: 'arrow-down-left' },
	{ kind: 'wipebr', label: 'Wipe Bottom Right', group: 'wipe', icon: 'arrow-down-right' },
	{ kind: 'smoothleft', label: 'Smooth Left', group: 'wipe', icon: 'chevrons-left' },
	{ kind: 'smoothright', label: 'Smooth Right', group: 'wipe', icon: 'chevrons-right' },
	{ kind: 'smoothup', label: 'Smooth Up', group: 'wipe', icon: 'chevrons-up' },
	{ kind: 'smoothdown', label: 'Smooth Down', group: 'wipe', icon: 'chevrons-down' },

	{ kind: 'slideright', label: 'Slide Right', group: 'slide', icon: 'arrow-right' },
	{ kind: 'slideup', label: 'Slide Up', group: 'slide', icon: 'arrow-up' },
	{ kind: 'slidedown', label: 'Slide Down', group: 'slide', icon: 'arrow-down' },
	{ kind: 'coverleft', label: 'Cover Left', group: 'slide', icon: 'layers-subtract' },
	{ kind: 'coverright', label: 'Cover Right', group: 'slide', icon: 'layers-subtract' },
	{ kind: 'coverup', label: 'Cover Up', group: 'slide', icon: 'layers-subtract' },
	{ kind: 'coverdown', label: 'Cover Down', group: 'slide', icon: 'layers-subtract' },
	{ kind: 'revealleft', label: 'Reveal Left', group: 'slide', icon: 'layers-difference' },
	{ kind: 'revealright', label: 'Reveal Right', group: 'slide', icon: 'layers-difference' },
	{ kind: 'revealup', label: 'Reveal Up', group: 'slide', icon: 'layers-difference' },
	{ kind: 'revealdown', label: 'Reveal Down', group: 'slide', icon: 'layers-difference' },

	{ kind: 'circleopen', label: 'Circle Open', group: 'shape', icon: 'circle-dashed' },
	{ kind: 'circleclose', label: 'Circle Close', group: 'shape', icon: 'circle-dot' },
	{ kind: 'circlecrop', label: 'Circle Crop', group: 'shape', icon: 'crop' },
	{ kind: 'rectcrop', label: 'Rectangle Crop', group: 'shape', icon: 'crop-1-1' },
	{ kind: 'vertopen', label: 'Vertical Open', group: 'shape', icon: 'arrows-vertical' },
	{ kind: 'vertclose', label: 'Vertical Close', group: 'shape', icon: 'fold' },
	{ kind: 'horzopen', label: 'Horizontal Open', group: 'shape', icon: 'arrows-horizontal' },
	{ kind: 'horzclose', label: 'Horizontal Close', group: 'shape', icon: 'fold-down' },
	{ kind: 'diagtl', label: 'Diagonal Top Left', group: 'shape', icon: 'triangle' },
	{ kind: 'diagtr', label: 'Diagonal Top Right', group: 'shape', icon: 'triangle-inverted' },
	{ kind: 'diagbl', label: 'Diagonal Bottom Left', group: 'shape', icon: 'triangle' },
	{ kind: 'diagbr', label: 'Diagonal Bottom Right', group: 'shape', icon: 'triangle-inverted' },
	{ kind: 'squeezeh', label: 'Squeeze Horizontal', group: 'shape', icon: 'arrows-minimize' },
	{ kind: 'squeezev', label: 'Squeeze Vertical', group: 'shape', icon: 'arrows-minimize' },

	{ kind: 'hlslice', label: 'Slice Left', group: 'motion', icon: 'layout-columns' },
	{ kind: 'hrslice', label: 'Slice Right', group: 'motion', icon: 'layout-columns' },
	{ kind: 'vuslice', label: 'Slice Up', group: 'motion', icon: 'layout-rows' },
	{ kind: 'vdslice', label: 'Slice Down', group: 'motion', icon: 'layout-rows' },
	{ kind: 'hlwind', label: 'Wind Left', group: 'motion', icon: 'wind' },
	{ kind: 'hrwind', label: 'Wind Right', group: 'motion', icon: 'wind' },
	{ kind: 'vuwind', label: 'Wind Up', group: 'motion', icon: 'wind' },
	{ kind: 'vdwind', label: 'Wind Down', group: 'motion', icon: 'wind' }
]

const BY_KIND = new Map(TRANSITION_PRESETS.map((p) => [p.kind, p]))

/** Guards the boundary: a `kind` from a persisted or AI-written document. */
export function isTransitionKind(kind: string): boolean {
	return BY_KIND.has(kind)
}

export function transitionPreset(kind: string): TransitionPreset | undefined {
	return BY_KIND.get(kind)
}

/** Human name for a kind, falling back to the raw name for anything unknown. */
export function transitionLabel(kind: string): string {
	return BY_KIND.get(kind)?.label ?? kind
}

/** Presets in display order, grouped, empty groups omitted. */
export function transitionGroups(): { group: TransitionGroup; label: string; presets: TransitionPreset[] }[] {
	const order: TransitionGroup[] = ['featured', 'blend', 'wipe', 'slide', 'shape', 'motion']
	return order
		.map((group) => ({
			group,
			label: TRANSITION_GROUP_LABELS[group],
			presets: TRANSITION_PRESETS.filter((p) => p.group === group)
		}))
		.filter((g) => g.presets.length > 0)
}
