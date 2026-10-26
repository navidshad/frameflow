import { describe, expect, it } from 'vitest'
import {
	aiReady, hdrOriginalNeedsProxy, laneOfStep, laneOfSteps, laneRecord, laneStatus, mediaReadiness, playsNatively,
	prepStatus, summarizeLanes, wantsFilmstrip
} from './mediaPrep'
import type { MediaAsset } from './types'

describe('prepStatus', () => {
	it('calls a stored "running" with no live chain interrupted', () => {
		// The app quit (or restarted) while a 91-minute file was being transcribed.
		expect(prepStatus('running', false)).toBe('interrupted')
		expect(prepStatus('running', true)).toBe('running')
	})
	it('passes every other state through', () => {
		expect(prepStatus('completed', false)).toBe('completed')
		expect(prepStatus('error', false)).toBe('error')
		expect(prepStatus('pending', false)).toBe('pending')
		expect(prepStatus(undefined, false)).toBe('pending')
	})
})

describe('wantsFilmstrip', () => {
	const used = { usedOnTimeline: true, live: false, alreadyRequested: false }
	const video = { kind: 'video' as const, preprocessState: 'running' as const, proxyPath: '/p/proxy.mov', filmstrip: undefined }

	it('needs only the proxy: an interrupted file with a proxy gets its strip', () => {
		expect(wantsFilmstrip(video, used)).toBe(true)
	})
	it('leaves it to a live chain, which draws it right after the proxy', () => {
		expect(wantsFilmstrip(video, { ...used, live: true })).toBe(false)
	})
	it('reads the original once the chain is done, even with no proxy', () => {
		expect(wantsFilmstrip({ ...video, preprocessState: 'completed', proxyPath: undefined }, used)).toBe(true)
		expect(wantsFilmstrip({ ...video, preprocessState: 'error', proxyPath: undefined }, used)).toBe(false)
	})
	it('asks once, only for video on the timeline without a strip', () => {
		expect(wantsFilmstrip(video, { ...used, alreadyRequested: true })).toBe(false)
		expect(wantsFilmstrip(video, { ...used, usedOnTimeline: false })).toBe(false)
		expect(wantsFilmstrip({ ...video, kind: 'audio' as any }, used)).toBe(false)
		expect(wantsFilmstrip({ ...video, filmstrip: [{ time: 0.5, path: '/f.jpg' }] as any }, used)).toBe(false)
	})
})


describe('lanes', () => {
	it('puts audio and transcript steps in the words lane and the rest in the picture lane', () => {
		expect(['audio', 'transcript', 'retranscribe'].map(laneOfStep)).toEqual(['words', 'words', 'words'])
		expect(['proxy', 'filmstrip', 'scenes', 'thumbnails', 'descriptions'].map(laneOfStep)).toEqual(Array(5).fill('picture'))
		// A named chain takes the lane all its steps belong to; mixed steps take the picture lane.
		expect(laneOfSteps(['audio', 'transcript'])).toBe('words')
		expect(laneOfSteps(['scenes', 'thumbnails'])).toBe('picture')
		expect(laneOfSteps(['transcript', 'scenes'])).toBe('picture')
	})

	it('reads media imported before the lanes existed as both lanes in the one stored state', () => {
		expect(laneRecord({ preprocessState: 'completed' }, 'words')).toEqual({ state: 'completed' })
		expect(laneRecord({ preprocessState: 'completed' }, 'picture')).toEqual({ state: 'completed' })
		expect(laneRecord({ preprocessState: 'error', preprocessError: 'bad' }, 'picture')).toEqual({ state: 'error', error: 'bad' })
		expect(laneRecord({ preprocessState: 'pending' }, 'words')).toBeUndefined()
		// Once a lane has its own record, the other is whatever it says, not the summary.
		expect(laneRecord({ preprocessState: 'running', prepLanes: { words: { state: 'running' } } }, 'picture')).toBeUndefined()
	})

	it('calls a lane whose stored "running" has nothing live interrupted, per lane', () => {
		const asset = { preprocessState: 'running' as const, prepLanes: { words: { state: 'completed' as const }, picture: { state: 'running' as const } } }
		expect(laneStatus(asset, 'words', false)).toBe('completed')
		expect(laneStatus(asset, 'picture', false)).toBe('interrupted')
		expect(laneStatus(asset, 'picture', true)).toBe('running')
	})

	it('summarises: running while any lane runs, an error only once nothing runs, else completed', () => {
		expect(summarizeLanes({ words: { state: 'running' }, picture: { state: 'error', error: 'proxy died' } })).toEqual({ state: 'running' })
		expect(summarizeLanes({ words: { state: 'completed' }, picture: { state: 'error', error: 'proxy died' } })).toEqual({ state: 'error', error: 'proxy died' })
		expect(summarizeLanes({ words: { state: 'completed' }, picture: { state: 'completed' } })).toEqual({ state: 'completed' })
		expect(summarizeLanes({ words: { state: 'completed' } })).toEqual({ state: 'completed' })
	})
})

const clip = { id: 'c', sourceAssetId: 'a', index: 1, in: 0, out: 1, duration: 1, selected: false }
const video = (over: Partial<MediaAsset> = {}): MediaAsset => ({
	id: 'a', kind: 'video', name: 'IMG_1.MOV', originalPath: '/v/IMG_1.MOV', preprocessing: {}, clips: [], createdAt: 0,
	metadata: { duration: 5460, width: 3840, height: 2160, size: 1, codec: 'hevc', fps: 30, format: 'mov', hasAudio: true },
	preprocessState: 'running', prepLanes: { words: { state: 'running' }, picture: { state: 'running' } },
	...over
})

describe('aiReady', () => {
	it('is true once the words lane is done and pieces exist, however far the picture lane is', () => {
		const wordsDone = video({ prepLanes: { words: { state: 'completed' }, picture: { state: 'running' } }, clips: [clip] })
		expect(aiReady(wordsDone)).toBe(true)
	})
	it('waits while the transcript runs, or when it is done but made no pieces', () => {
		expect(aiReady(video({ clips: [clip] }))).toBe(false)
		expect(aiReady(video({ prepLanes: { words: { state: 'completed' }, picture: { state: 'running' } } }))).toBe(false)
	})
	it('keeps working for media made before the lanes existed', () => {
		expect(aiReady(video({ prepLanes: undefined, preprocessState: 'completed', clips: [clip] }))).toBe(true)
		expect(aiReady(video({ prepLanes: undefined, preprocessState: 'running', clips: [clip] }))).toBe(false)
	})
})

describe('playsNatively', () => {
	it('says yes to H.264 and HEVC in mp4/mov on a Mac, and H.264 only elsewhere', () => {
		expect(playsNatively({ codec: 'hevc' }, '/v/IMG.MOV')).toBe(true)
		expect(playsNatively({ codec: 'h264' }, '/v/clip.mp4')).toBe(true)
		expect(playsNatively({ codec: 'h264' }, '/v/clip.m4v')).toBe(true)
		expect(playsNatively({ codec: 'hevc' }, '/v/IMG.MOV', 'win32')).toBe(false)
		expect(playsNatively({ codec: 'h264' }, '/v/clip.mp4', 'win32')).toBe(true)
	})
	it('says yes to VP9 in WebM', () => {
		expect(playsNatively({ codec: 'vp9' }, '/v/a.webm')).toBe(true)
		expect(playsNatively({ codec: 'av1' }, '/v/a.webm')).toBe(false) // plays, but in software
	})
	it('says no to what was measured unsupported: ProRes, MPEG-4 part 2, VVC, and codecs in a container the browser will not open', () => {
		expect(playsNatively({ codec: 'prores' }, '/v/a.mov')).toBe(false)
		expect(playsNatively({ codec: 'mpeg4' }, '/v/a.mp4')).toBe(false)
		expect(playsNatively({ codec: 'vvc' }, '/v/a.mp4')).toBe(false)
		expect(playsNatively({ codec: 'h264' }, '/v/a.avi')).toBe(false)
		expect(playsNatively({ codec: 'h264' }, '/v/a.mkv')).toBe(false)
	})
	it('says no to 4:2:2 and 4:4:4, which the video chip does not decode', () => {
		expect(playsNatively({ codec: 'hevc', pixFmt: 'yuv422p10le' }, '/v/a.mov')).toBe(false)
		expect(playsNatively({ codec: 'hevc', pixFmt: 'yuv420p10le' }, '/v/a.mov')).toBe(true)
	})
	it('says no when it knows nothing about the file', () => {
		expect(playsNatively(undefined, '/v/a.mp4')).toBe(false)
	})
})

describe('hdrOriginalNeedsProxy (the HDR policy)', () => {
	it('flags HLG (an iPhone) and PQ, and nothing else', () => {
		expect(hdrOriginalNeedsProxy({ colorTransfer: 'arib-std-b67' })).toBe(true)
		expect(hdrOriginalNeedsProxy({ colorTransfer: 'smpte2084' })).toBe(true)
		expect(hdrOriginalNeedsProxy({ colorTransfer: 'bt709' })).toBe(false)
		expect(hdrOriginalNeedsProxy({})).toBe(false)
		expect(hdrOriginalNeedsProxy(undefined)).toBe(false)
	})
})

describe('mediaReadiness', () => {
	const texts = (a: MediaAsset, opts?: Parameters<typeof mediaReadiness>[1]) => mediaReadiness(a, opts).chips.map((c) => c.text)

	it('says a playable file is ready to edit the moment it is probed, while the transcript and proxy run', () => {
		const r = mediaReadiness(video(), { proxyPercent: 40 })
		expect(r).toMatchObject({ placeable: true, playsFrom: 'original', aiReady: false, settled: false })
		expect(r.chips.map((c) => c.text)).toEqual(['Ready to edit', 'Transcript in progress', 'Proxy 40%'])
	})

	it('says a file the browser cannot play can be placed but needs its proxy to preview', () => {
		const prores = video({ metadata: { ...video().metadata!, codec: 'prores' } })
		expect(mediaReadiness(prores).playsFrom).toBe('nothing')
		expect(texts(prores)[0]).toMatch(/preview needs the proxy/)
		expect(mediaReadiness({ ...prores, proxyPath: '/p/x.mov' }).playsFrom).toBe('proxy')
	})

	it('notes that HDR colours are not final until the proxy exists, and drops the note when it does', () => {
		const hdr = video({ metadata: { ...video().metadata!, colorTransfer: 'arib-std-b67' } })
		expect(mediaReadiness(hdr).colourFinal).toBe(false)
		expect(texts(hdr)).toContain('Colours not final')
		const withProxy = { ...hdr, proxyPath: '/p/x.mov' }
		expect(mediaReadiness(withProxy).colourFinal).toBe(true)
		expect(texts(withProxy)).not.toContain('Colours not final')
		// A source small enough to be its own proxy was never tagged, so it does not count.
		expect(mediaReadiness({ ...hdr, proxyPath: hdr.originalPath }).colourFinal).toBe(false)
	})

	it('shows each lane on its own: transcript ready while the proxy runs, and a failed proxy beside a finished transcript', () => {
		const wordsDone = video({
			prepLanes: { words: { state: 'completed' }, picture: { state: 'running' } },
			preprocessing: { transcriptPath: '/t.json' }, clips: [clip]
		})
		expect(texts(wordsDone, { proxyPercent: 12 })).toEqual(['Ready to edit', 'Transcript ready', 'Proxy 12%'])
		const proxyFailed = { ...wordsDone, preprocessState: 'error' as const, prepLanes: { words: { state: 'completed' as const }, picture: { state: 'error' as const, error: 'x' } } }
		expect(texts(proxyFailed)).toEqual(['Ready to edit', 'Transcript ready', 'Proxy failed'])
	})

	it('says paused for an interrupted lane only', () => {
		const stuck = video({ prepLanes: { words: { state: 'completed' }, picture: { state: 'running' } }, preprocessing: { transcriptPath: '/t.json' } })
		expect(texts(stuck, { interrupted: ['picture'] })).toEqual(['Ready to edit', 'Transcript ready', 'Proxy paused'])
	})

	it('is settled, with nothing to say, once both lanes are done', () => {
		const done = video({ preprocessState: 'completed', prepLanes: { words: { state: 'completed' }, picture: { state: 'completed' } }, proxyPath: '/p.mov' })
		expect(mediaReadiness(done).settled).toBe(true)
	})

	it('does not announce a silent video\'s transcript', () => {
		const silent = video({ metadata: { ...video().metadata!, hasAudio: false } })
		expect(texts(silent)).not.toContain('Transcript in progress')
	})
})
