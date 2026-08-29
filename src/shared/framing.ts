/**
 * Where a clip sits inside a sequence frame of a different shape.
 *
 * Two places have to agree about this: the export filter chain in
 * `renderBuilders.vnorm`, and the monitor, which shows the same picture with
 * CSS. Preview/export drift is treated as a bug in this codebase — `preview.ts`
 * exists because of it — so the one number they disagree about lives here and
 * both derive from it.
 */

/** A pan outside the frame means nothing; a non-finite one means centred. */
export const clampPan = (pan?: number): number =>
	typeof pan === 'number' && Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0

/**
 * How much of a cover-scaled image is cut from the LEFT (or TOP), as a fraction
 * of the total overflow. 0 keeps the left/top edge, 1 the right/bottom, 0.5
 * centres — which is what a pan of -1, +1 and 0 mean respectively.
 *
 * ffmpeg spends it as `crop=W:H:(iw-ow)*f`, CSS as `object-position: f*100%`.
 * Those are the same mapping written in two syntaxes.
 */
export const panFraction = (pan?: number): number => (clampPan(pan) + 1) / 2

/** `object-position` for a `fill` clip, matching the crop the export will make. */
export const panObjectPosition = (pan?: number): string => {
	const pct = `${(panFraction(pan) * 100).toFixed(3).replace(/\.?0+$/, '')}%`
	return `${pct} ${pct}`
}

/** Just the dimensions the frame rule cares about — `VideoMetadata`, loosely. */
export interface FrameSource {
	width?: number
	height?: number
}

/**
 * The shape the sequence exports in: the frame it chose, or — for every project
 * that never chose one — the largest source it uses, which is what this app has
 * always done.
 *
 * Both the render and the monitor resolve it through here. They used to answer
 * separately, and a project with no chosen frame would then export at its
 * footage's shape while the monitor drew a 16:9 box around it.
 *
 * Dimensions come back even: h264 cannot encode an odd one.
 */
export function sequenceFrame(
	meta: { width?: number; height?: number; frameChosen?: boolean } | undefined,
	sources: FrameSource[]
): { width: number; height: number } {
	const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
	if (meta?.frameChosen && meta.width && meta.height) {
		return { width: even(meta.width), height: even(meta.height) }
	}
	// Defaults keep an audio-only export at a sane 720p.
	const largest = sources.reduce(
		(best, s) => {
			const area = (s.width || 0) * (s.height || 0)
			return area > best.area ? { area, w: s.width!, h: s.height! } : best
		},
		{ area: 0, w: 1280, h: 720 }
	)
	return { width: even(largest.w), height: even(largest.h) }
}

/** The shapes worth one click. Anything else is a per-project decision nobody
 *  makes twice, so there is no free-form W×H field. */
export const FRAME_PRESETS: { label: string; short: string; w: number; h: number }[] = [
	{ label: 'Landscape', short: '16:9', w: 1920, h: 1080 },
	{ label: 'Vertical', short: '9:16', w: 1080, h: 1920 },
	{ label: 'Square', short: '1:1', w: 1080, h: 1080 },
	{ label: 'Portrait', short: '4:5', w: 1080, h: 1350 }
]
