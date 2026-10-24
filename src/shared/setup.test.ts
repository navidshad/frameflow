import { describe, expect, it } from 'vitest'
import { buildChecks, checksPass, classifyGeminiKeyResponse, isSetupComplete, tildePath } from './setup'

describe('isSetupComplete', () => {
	it('needs a key and a folder the OS will not clear', () => {
		expect(isSetupComplete({ hasKey: true, tempUnsafe: false })).toBe(true)
		expect(isSetupComplete({ hasKey: false, tempUnsafe: false })).toBe(false)
		expect(isSetupComplete({ hasKey: true, tempUnsafe: true })).toBe(false)
	})
	it('leaves existing users alone (no flag) but honours an explicit false', () => {
		expect(isSetupComplete({ hasKey: true, tempUnsafe: false, flag: undefined })).toBe(true)
		expect(isSetupComplete({ hasKey: true, tempUnsafe: false, flag: true })).toBe(true)
		expect(isSetupComplete({ hasKey: true, tempUnsafe: false, flag: false })).toBe(false)
	})
})

describe('classifyGeminiKeyResponse', () => {
	it('accepts any 2xx', () => expect(classifyGeminiKeyResponse(200, '{}')).toEqual({ ok: true }))
	it('reads a bad key', () => {
		const r = classifyGeminiKeyResponse(400, JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }))
		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/does not accept/)
	})
	it('separates forbidden, quota and the unknown', () => {
		expect(classifyGeminiKeyResponse(403, '').error).toMatch(/not allowed/)
		expect(classifyGeminiKeyResponse(429, '').error).toMatch(/quota/)
		expect(classifyGeminiKeyResponse(500, '{"error":{"message":"boom"}}').error).toBe('boom')
		expect(classifyGeminiKeyResponse(502, 'html').error).toMatch(/502/)
	})
})

describe('tildePath', () => {
	it('shortens the home folder only at a boundary', () => {
		expect(tildePath('/Users/ada/Movies/FrameFlow', '/Users/ada')).toBe('~/Movies/FrameFlow')
		expect(tildePath('/Users/adam/x', '/Users/ada')).toBe('/Users/adam/x')
		expect(tildePath('/Users/ada', '/Users/ada')).toBe('~')
	})
})

describe('buildChecks', () => {
	const base = { ffmpeg: { available: true, version: '9.0.1' }, folder: '~/Movies/FrameFlow', folderWritable: true, geminiKeyOk: true, elevenLabsKey: false }
	it('treats generated audio as optional', () => {
		const rows = buildChecks(base)
		expect(rows.find((r) => r.id === 'audio')?.state).toBe('off')
		expect(checksPass(rows)).toBe(true)
	})
	it('blocks on a missing ffmpeg, an unwritable folder or an unchecked key', () => {
		expect(checksPass(buildChecks({ ...base, ffmpeg: { available: false } }))).toBe(false)
		expect(checksPass(buildChecks({ ...base, folderWritable: false }))).toBe(false)
		expect(checksPass(buildChecks({ ...base, geminiKeyOk: false }))).toBe(false)
	})
})
