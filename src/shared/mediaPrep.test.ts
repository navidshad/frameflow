import { describe, expect, it } from 'vitest'
import { prepStatus, wantsFilmstrip } from './mediaPrep'

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
