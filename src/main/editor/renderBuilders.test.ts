import { describe, expect, it } from 'vitest'
import type { TimelineItem, Track } from '@shared/types'
import {
	allSlices, atempoChain, buildRegionGraph,
	type CutRegion, type OverlapRegion, type RegionPlan, type SourceSlice
} from './renderBuilders'

// ===== Fixtures =====

const track: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: over.id ?? 'i1', trackId: 'v1', sourceAssetId: 'a',
	timelineStart: 0, in: 0, out: 10, speed: 1, preservePitch: true, duration: 10, ...over
})

/** A slice spanning its whole region unless told otherwise. */
const slice = (over: Partial<SourceSlice> = {}): SourceSlice => ({
	srcPath: '/tmp/a.mp4', in: 0, out: 2,
	offset: 0, duration: 2, freezeHead: 0, freezeTail: 0,
	item: item(), track, ...over
})

const plan: RegionPlan = {
	regions: [], width: 1920, height: 1080, fps: 30, duration: 0, hasOverlap: false
}

const cut = (over: Partial<CutRegion> = {}): CutRegion => ({
	kind: 'cut', duration: 2, videoLayers: [], audioSources: [], ...over
})

const overlap = (over: Partial<OverlapRegion> = {}): OverlapRegion => ({
	kind: 'overlap', duration: 2,
	transition: { kind: 'fade', duration: 2 },
	from: slice({ item: item({ id: 'A' }), srcPath: '/tmp/A.mp4' }),
	to: slice({ item: item({ id: 'B' }), srcPath: '/tmp/B.mp4' }),
	cutAt: 1, fromAudioActive: true, toAudioActive: true, audioSources: [], ...over
})

const graphOf = (region: CutRegion | OverlapRegion) => {
	const g = buildRegionGraph(region, plan)
	return { ...g, text: g.filters.join(';') }
}

// ===== Ordinary regions =====

describe('buildRegionGraph — cut regions', () => {
	it('normalizes the top layer and maps it as the picture', () => {
		const g = graphOf(cut({ videoLayers: [slice()] }))
		expect(g.video).toBe('[v]')
		expect(g.text).toContain('scale=1920:1080:force_original_aspect_ratio=decrease')
		expect(g.text).toContain('fps=30')
		expect(g.inputs[0]).toEqual({ path: '/tmp/a.mp4', options: ['-ss', '0.000', '-t', '2.000'] })
	})

	it('pads nothing when a slice spans its whole region', () => {
		// The shape every existing export relies on: no placement filters at all.
		const g = graphOf(cut({ videoLayers: [slice()], audioSources: [slice()] }))
		expect(g.text).not.toContain('tpad')
		expect(g.text).not.toContain('adelay')
	})

	it('renders black and silence for an empty region', () => {
		const g = graphOf(cut())
		expect(g.inputs[0].format).toBe('lavfi')
		expect(g.inputs[0].path).toContain('color=black')
		expect(g.inputs[1].path).toContain('anullsrc')
		expect(g.audio).toBe('[a]')
	})

	it('passes a lone audio source straight through without a mixer', () => {
		const g = graphOf(cut({ videoLayers: [slice()], audioSources: [slice()] }))
		expect(g.audio).toBe('[a0]')
		expect(g.text).not.toContain('amix')
	})

	it('mixes several audio sources at unity', () => {
		const g = graphOf(cut({ videoLayers: [slice()], audioSources: [slice(), slice()] }))
		expect(g.text).toContain('[a0][a1]amix=inputs=2:normalize=0[a]')
	})

	it('pins every audio stream to the region length', () => {
		const g = graphOf(cut({ audioSources: [slice({ out: 1 })] }))
		expect(g.text).toContain('apad=whole_dur=2.000,atrim=0:2.000')
	})
})

// ===== Reframing =====

describe('vnorm — framing', () => {
	const chainOf = (framing?: { mode: 'fit' | 'fill'; pan?: number }) =>
		graphOf(cut({ videoLayers: [slice({ item: item({ framing }) })] })).text

	it('letterboxes by default, exactly as it always has', () => {
		// Every existing project must render byte-identically: nothing has ever
		// written a framing, so the absent case is the whole back catalogue.
		expect(chainOf()).toContain('scale=1920:1080:force_original_aspect_ratio=decrease')
		expect(chainOf()).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2')
		expect(chainOf()).not.toContain('crop=')
	})

	it('treats an explicit fit the same as none', () => {
		expect(chainOf({ mode: 'fit' })).toBe(chainOf())
	})

	it('covers and crops when told to fill', () => {
		const chain = chainOf({ mode: 'fill' })
		expect(chain).toContain('scale=1920:1080:force_original_aspect_ratio=increase')
		expect(chain).toContain('crop=1920:1080:(iw-ow)/2:(ih-oh)/2')
		expect(chain).not.toContain('pad=')
	})

	it('walks the crop toward an edge as the pan moves', () => {
		// The offset is an expression over iw/ih — the SCALED image — so this needs
		// no source dimensions and works for either orientation.
		expect(chainOf({ mode: 'fill', pan: -1 })).toContain('crop=1920:1080:(iw-ow)*0:(ih-oh)*0')
		expect(chainOf({ mode: 'fill', pan: 1 })).toContain('crop=1920:1080:(iw-ow)*1:(ih-oh)*1')
		expect(chainOf({ mode: 'fill', pan: 0.5 })).toContain('(iw-ow)*0.75')
	})

	it('clamps a pan beyond the frame', () => {
		expect(chainOf({ mode: 'fill', pan: 5 })).toBe(chainOf({ mode: 'fill', pan: 1 }))
		expect(chainOf({ mode: 'fill', pan: -5 })).toBe(chainOf({ mode: 'fill', pan: -1 }))
	})

	it('omits the pan term entirely when centred', () => {
		expect(chainOf({ mode: 'fill', pan: 0 })).toBe(chainOf({ mode: 'fill' }))
	})

	it('normalizes both sides of a transition the same way', () => {
		// xfade requires identical geometry; a framed clip must not break that.
		const g = graphOf(overlap({
			from: slice({ item: item({ id: 'A', framing: { mode: 'fill' } }), srcPath: '/tmp/A.mp4' }),
			to: slice({ item: item({ id: 'B', framing: { mode: 'fill', pan: 1 } }), srcPath: '/tmp/B.mp4' })
		}))
		expect(g.text.match(/crop=1920:1080/g)).toHaveLength(2)
		expect(g.text).toContain('xfade=')
	})
})

// ===== Region-local placement (the Stage A regression) =====

describe('buildRegionGraph — slice placement', () => {
	it('delays an audio slice that starts partway through its region', () => {
		// REGRESSION. Collapsing near-coincident boundaries means a region no longer
		// starts at every item edge, so a bed can begin inside one. Without adelay
		// it played from the top of the region — up to 50ms early, against picture.
		const g = graphOf(cut({ audioSources: [slice({ offset: 0.02, duration: 1.98 })] }))
		expect(g.text).toContain('adelay=20|20')
	})

	it('delays after the builder chain, so a fade envelope is not dragged with it', () => {
		// fadeA emits volume=…:eval=frame in stream-relative t; delaying upstream
		// would move the ramp as well as the audio.
		const g = graphOf(cut({
			audioSources: [slice({ offset: 0.5, duration: 1.5, item: item({ fadeInSec: 1 }) })]
		}))
		expect(g.text.indexOf('volume=')).toBeLessThan(g.text.indexOf('adelay='))
	})

	it('pads a late video slice with black rather than refusing to render it', () => {
		const g = graphOf(cut({ videoLayers: [slice({ offset: 0.02, duration: 1.98 })] }))
		expect(g.text).toContain('tpad=start_mode=add:start_duration=0.020:color=black')
	})

	it('pads both ends of a video slice that is shorter than its region', () => {
		const g = graphOf(cut({ videoLayers: [slice({ offset: 0.5, duration: 1 })] }))
		expect(g.text).toContain('start_mode=add:start_duration=0.500')
		expect(g.text).toContain('stop_mode=add:stop_duration=0.500')
	})

	it('rounds a sub-millisecond offset away rather than emitting a no-op delay', () => {
		const g = graphOf(cut({ audioSources: [slice({ offset: 0.0001, duration: 1.9999 })] }))
		expect(g.text).not.toContain('adelay')
	})
})

// ===== Transitions =====

describe('buildRegionGraph — overlap regions', () => {
	it('blends the two clips across the whole window', () => {
		const g = graphOf(overlap())
		expect(g.text).toContain('[vf][vt]xfade=transition=fade:duration=2.000:offset=0[v]')
	})

	it('carries the chosen preset', () => {
		const g = graphOf(overlap({ transition: { kind: 'wipeleft', duration: 2 } }))
		expect(g.text).toContain('xfade=transition=wipeleft')
	})

	it('normalizes both sides, because xfade requires matching geometry', () => {
		const g = graphOf(overlap())
		expect(g.text.match(/scale=1920:1080/g)).toHaveLength(2)
	})

	it('feeds both sources as separate inputs', () => {
		const g = graphOf(overlap())
		expect(g.inputs.map((i) => i.path)).toEqual(['/tmp/A.mp4', '/tmp/B.mp4', '/tmp/A.mp4', '/tmp/B.mp4'])
	})

	it('crossfades the pair at equal power and never mixes them', () => {
		// Both at full level through the window is audible double-talk.
		const g = graphOf(overlap())
		expect(g.text).toContain('[af][at]acrossfade=d=2.000:c1=qsin:c2=qsin[apair]')
		expect(g.audio).toBe('[apair]')
		expect(g.text).not.toContain('amix')
	})

	it('holds the outgoing clip on its last frame when its handle runs out', () => {
		const g = graphOf(overlap({ from: slice({ out: 1.5, duration: 2, freezeTail: 0.5 }) }))
		expect(g.text).toContain('tpad=stop_mode=clone:stop_duration=0.500')
	})

	it('holds the incoming clip on its first frame at the head of the window', () => {
		const g = graphOf(overlap({ to: slice({ out: 1.5, duration: 2, freezeHead: 0.5 }) }))
		expect(g.text).toContain('tpad=start_mode=clone:start_duration=0.500')
	})

	it('fills a frozen audio head with silence, not repeated samples', () => {
		const g = graphOf(overlap({ to: slice({ out: 1.5, duration: 2, freezeHead: 0.5 }) }))
		expect(g.text).toContain('adelay=500|500')
	})

	it('gives a silent side its half of the ramp against silence', () => {
		const g = graphOf(overlap({ toAudioActive: false }))
		expect(g.inputs.some((i) => i.path.includes('anullsrc'))).toBe(true)
		expect(g.text).toContain('acrossfade')
	})

	it('mixes a bystander bed on top of the blended pair', () => {
		const bed = slice({ item: item({ id: 'BED' }), srcPath: '/tmp/bed.m4a' })
		const g = graphOf(overlap({ audioSources: [bed] }))
		expect(g.text).toContain('[apair][ab0]amix=inputs=2:normalize=0[a]')
		expect(g.audio).toBe('[a]')
	})

	it('places a bed that enters partway through the window', () => {
		const bed = slice({ item: item({ id: 'BED' }), srcPath: '/tmp/bed.m4a', offset: 0.4, duration: 1.6 })
		const g = graphOf(overlap({ audioSources: [bed] }))
		expect(g.text).toContain('adelay=400|400')
	})
})

// ===== allSlices / atempoChain =====

describe('allSlices', () => {
	it('reaches both sides of a transition and its bystanders', () => {
		const bed = slice({ item: item({ id: 'BED' }) })
		expect(allSlices(overlap({ audioSources: [bed] })).map((s) => s.item.id)).toEqual(['A', 'B', 'BED'])
	})
})

describe('atempoChain', () => {
	it('keeps every stage inside ffmpeg 0.5–2.0 range', () => {
		for (const speed of [0.25, 0.5, 1, 1.5, 2, 3, 4]) {
			const stages = atempoChain(speed).split(',').map((s) => Number(s.replace('atempo=', '')))
			for (const stage of stages) {
				expect(stage).toBeGreaterThanOrEqual(0.5)
				expect(stage).toBeLessThanOrEqual(2)
			}
			expect(stages.reduce((a, b) => a * b, 1)).toBeCloseTo(speed, 6)
		}
	})
})

// ===== Effects =====

describe('effects in the region graph', () => {
	const chainOf = (effects?: { id: string; kind: string; params?: Record<string, number> }[]) =>
		graphOf(cut({ videoLayers: [slice({ item: item({ effects }) })] })).text

	it('emits nothing when a clip has no effects', () => {
		expect(chainOf()).toBe(chainOf([]))
	})

	it('puts the filter in the clip’s own chain', () => {
		expect(chainOf([{ id: 'e', kind: 'saturation', params: { amount: 0 } }]))
			.toContain('eq=saturation=0')
	})

	it('runs effects BEFORE the conform, so they act in source pixels', () => {
		// vnorm scales and pads to the sequence frame; a blur applied after that
		// would smear the letterbox bars into the picture.
		const chain = chainOf([{ id: 'e', kind: 'blur', params: { radius: 3 } }])
		expect(chain.indexOf('gblur')).toBeLessThan(chain.indexOf('scale=1920:1080'))
	})

	it('keeps the order the user put them in', () => {
		const chain = chainOf([
			{ id: 'a', kind: 'blur', params: { radius: 3 } },
			{ id: 'b', kind: 'sharpen', params: { amount: 1 } }
		])
		expect(chain.indexOf('gblur')).toBeLessThan(chain.indexOf('unsharp'))
	})

	it('does not emit a stray comma for an effect left at its defaults', () => {
		// `buildChain` drops empty fragments, and an untouched effect IS empty —
		// a bare comma would make the whole filtergraph unparseable.
		const chain = chainOf([{ id: 'e', kind: 'contrast', params: { amount: 1 } }])
		expect(chain).not.toMatch(/,,/)
		expect(chain).toBe(chainOf())
	})
})

// ===== Padding a compositing layer =====

describe('vpad on a layer', () => {
	/**
	 * `color` is ONE ffmpeg option however many times it is written, and the last
	 * assignment wins. Writing it per part AND again at the end made every alpha
	 * pad opaque, so a layer that did not span its whole region blacked out
	 * everything beneath it. These assert the option appears exactly once.
	 */
	const padOf = (chain: string) => chain.match(/tpad=[^,]*/)?.[0] ?? ''

	const layerChain = (alpha: boolean) => graphOf(cut({
		duration: 4,
		videoLayers: [slice({ offset: 1, duration: 2, item: item({ timelineStart: 1, duration: 2 }) })]
	})).text

	it('names the fill colour once, not twice', () => {
		const pad = padOf(layerChain(false))
		expect(pad).toContain('tpad=')
		expect(pad.match(/color=/g) ?? []).toHaveLength(1)
	})

	it('pads an ordinary clip with opaque black', () => {
		expect(padOf(layerChain(false))).toContain('color=black')
		expect(padOf(layerChain(false))).not.toContain('black@0')
	})

	it('emits no colour at all for a freeze, which repeats a frame', () => {
		const chain = graphOf(cut({
			duration: 4,
			videoLayers: [slice({ freezeHead: 1, duration: 3 })]
		})).text
		const freeze = chain.match(/tpad=start_mode=clone[^,]*/)?.[0] ?? ''
		expect(freeze).not.toContain('color=')
	})
})
