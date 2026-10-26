import { describe, expect, it } from 'vitest'
import {
	applyWordFixes, buildMixedScriptRequest, findMixedScriptWords, parseLanguageLine, parseMixedScriptFixes, parseTranscript,
	TRANSCRIPT_CORRECTION_PROMPT, TRANSCRIPT_PROMPT
} from './transcript-format'
import { explainTranscriptError } from './transcript-errors'

describe('native script (Persian came back as Finglish)', () => {
	it('both prompts demand the spoken language’s own script and forbid romanising', () => {
		for (const prompt of [TRANSCRIPT_PROMPT, TRANSCRIPT_CORRECTION_PROMPT]) {
			expect(prompt).toMatch(/own writing system/)
			expect(prompt).toMatch(/Persian/)
			expect(prompt).toMatch(/NEVER romanise/)
		}
	})

	it('asks for the language up front and reads it back', () => {
		expect(TRANSCRIPT_PROMPT).toMatch(/LANGUAGE: fa/)
		expect(parseLanguageLine('LANGUAGE: fa\n00:00:01,000 , 00:00:02,000 - سلام')).toBe('fa')
		expect(parseLanguageLine('  LANGUAGE: pt-BR  \n')).toBe('pt-BR')
		expect(parseLanguageLine('00:00:01,000 , 00:00:02,000 - hi')).toBeUndefined()
	})

	it('the language line is not mistaken for a segment', () => {
		const items = parseTranscript('LANGUAGE: fa\n00:00:01,000 , 00:00:02,500 - سلام و درود.')
		expect(items).toEqual([{ start: '00:00:01,000', end: '00:00:02,500', text: 'سلام و درود.' }])
	})
})

describe('explainTranscriptError', () => {
	it('names a retired model and says where to change it', () => {
		const msg = explainTranscriptError(
			'[404 Not Found] This model models/gemini-2.5-flash-lite is no longer available to new users.',
			'gemini-2.5-flash-lite'
		)
		expect(msg).toContain('gemini-2.5-flash-lite')
		expect(msg).toContain('Settings → Models')
	})

	it('explains a missing key and a quota', () => {
		expect(explainTranscriptError('Gemini API key not found in settings.')).toMatch(/API key/)
		expect(explainTranscriptError('429 RESOURCE_EXHAUSTED quota', 'x')).toMatch(/quota/)
	})

	it('says plainly when the prepaid credits are gone, not "wait and retry"', () => {
		const raw = '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}'
		const msg = explainTranscriptError(raw, 'gemini-3.5-transcribe')
		expect(msg).toMatch(/prepaid credits are depleted/)
		expect(msg).toContain('AI Studio')
		expect(msg).not.toMatch(/quota|Wait and retry/)
		// A genuine rate limit keeps its own wording.
		expect(explainTranscriptError('429 RESOURCE_EXHAUSTED quota', 'x')).toMatch(/quota/)
	})

	it('passes anything else through', () => {
		expect(explainTranscriptError('socket hang up')).toBe('Transcription failed: socket hang up')
	})
})

describe('half-romanised words', () => {
	const items = [
		{ text: 'امروز می‌خam راجع به یه تصمیم جدید صحبت کنم', words: [{ start: 1, end: 1.3, text: 'امروز' }, { start: 1.3, end: 1.6, text: 'می‌خam' }] },
		{ text: 'من سه ساله ترکیه‌am و می‌خam برم' },
		{ text: 'This is plain English, and دیجیتال نومد is Persian.' }
	]

	it('finds each word that mixes Latin into another script, once', () => {
		expect(findMixedScriptWords(items).map((b) => b.word)).toEqual(['می‌خam', 'ترکیه‌am'])
		expect(findMixedScriptWords([{ text: 'Привет worldмир café' }]).map((b) => b.word)).toEqual(['worldмир'])
	})

	it('sends each word with its sentence', () => {
		const req = buildMixedScriptRequest(findMixedScriptWords(items))
		expect(req).toContain('1. word: می‌خam')
		expect(req).toContain('sentence: من سه ساله ترکیه‌am و می‌خam برم')
	})

	it('reads the reply, rejecting repairs that are still mixed or not one word', () => {
		const broken = [{ word: 'a‌خam' }, { word: 'b' }, { word: 'c' }]
		const fixes = parseMixedScriptFixes('```json\n["می‌خوام", "still خam", "ترکیهam"]\n```', broken)!
		expect([...fixes]).toEqual([['a‌خam', 'می‌خوام']])
		expect(parseMixedScriptFixes('not json', broken)).toBeNull()
		expect(parseMixedScriptFixes('["one"]', broken)).toBeNull() // wrong count
	})

	it('swaps repairs into text and word timings, keeping the times', () => {
		const fixed = applyWordFixes(items, new Map([['می‌خam', 'می‌خوام'], ['ترکیه‌am', 'ترکیه‌ام']]))
		expect(fixed[0].text).toBe('امروز می‌خوام راجع به یه تصمیم جدید صحبت کنم')
		expect(fixed[0].words![1]).toEqual({ start: 1.3, end: 1.6, text: 'می‌خوام' })
		expect(fixed[1].text).toBe('من سه ساله ترکیه‌ام و می‌خوام برم')
		expect(fixed[2]).toBe(items[2])
	})
})
