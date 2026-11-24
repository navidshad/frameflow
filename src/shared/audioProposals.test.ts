import { describe, expect, it } from 'vitest'
import {
	answerProblem, assistantChoices, effectiveAccess, followUpMessage, itemFromInput, proposalCredits, type AudioProposal
} from './audioProposals'
import { parseSpecModels, parseSpeechModels, type ModelCatalog } from './audioModels'
import spec from './__fixtures__/elevenlabs-openapi-slice.json'

const CATALOG: ModelCatalog = {
	provider: 'elevenlabs', fetchedAt: 1, rates: { eleven_multilingual_v2: 0.4, music_v2_5: 12 },
	models: [
		...parseSpeechModels([{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 10000 }]),
		...parseSpecModels(spec)
	]
}

const proposal = (over: Partial<AudioProposal> = {}): AudioProposal => ({
	id: 'prop-1', threadId: 't1', agent: 'Claude Code', status: 'open', createdAt: 0,
	items: [
		{ request: { provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome back.' }, purpose: 'Intro', autoModel: 'eleven_multilingual_v2' },
		{ request: { provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 10, model: 'music_v2' }, autoModel: 'music_v2' }
	],
	...over
})

describe('the level in force', () => {
	it('is Off whenever Settings says off; a project marked Auto is Auto; else Settings decides', () => {
		expect(effectiveAccess('off', true)).toBe('off')
		expect(effectiveAccess('ask', true)).toBe('auto')
		expect(effectiveAccess('ask', false)).toBe('ask')
		expect(effectiveAccess('auto', undefined)).toBe('auto')
	})
})

describe('an assistant’s item', () => {
	it('keeps the assistant’s reason for its choice, for the person to read', () => {
		const made = itemFromInput({ capability: 'speech', prompt: 'Hello there.', why: ' The steadiest model for narration. ' }, 'elevenlabs', CATALOG)
		expect(made).toMatchObject({ item: { why: 'The steadiest model for narration.' } })
	})

	it('becomes a request with only the fields its kind takes', () => {
		const made = itemFromInput({
			capability: 'speech', prompt: 'Hello there.', voice: ' v1 ', durationSec: 9, loop: true, instrumental: false, purpose: 'Greeting'
		}, 'elevenlabs', CATALOG)
		expect(made).toEqual({ item: { request: { provider: 'elevenlabs', capability: 'speech', prompt: 'Hello there.', voice: 'v1' }, purpose: 'Greeting' } })
		const song = itemFromInput({ capability: 'music', prompt: 'a folk song', instrumental: false, durationSec: 20, voice: 'v1' }, 'elevenlabs', CATALOG)
		expect(song).toEqual({ item: { request: { provider: 'elevenlabs', capability: 'music', prompt: 'a folk song', durationSec: 20, instrumental: false } } })
	})

	it('is refused with the reason when it cannot be made', () => {
		expect(itemFromInput({ capability: 'jingle', prompt: 'x' }, 'elevenlabs', CATALOG)).toEqual({ problem: 'capability must be speech, sfx or music.' })
		expect(itemFromInput({ capability: 'music', prompt: 'calm', model: 'music_v9' }, 'elevenlabs', CATALOG)).toMatchObject({ problem: expect.stringMatching(/no music model "music_v9"/) })
		// A retiring model still works until its removal date: it is offered, not refused.
		expect(itemFromInput({ capability: 'music', prompt: 'calm', model: 'music_v1' }, 'elevenlabs', CATALOG)).toHaveProperty('item')
	})
})

describe('an answer', () => {
	it('is acted on when it matches what was proposed and can be made', () => {
		const p = proposal()
		expect(answerProblem(p, { action: 'make', chosenBy: 'person', items: p.items.map((i) => i.request) }, CATALOG)).toBeNull()
		expect(answerProblem(p, { action: 'decline' }, CATALOG)).toBeNull()
	})

	it('is refused when it changes the kind, is short an item, comes twice, or cannot be made', () => {
		const p = proposal()
		const [a, b] = p.items.map((i) => i.request)
		expect(answerProblem(p, { action: 'make', chosenBy: 'person', items: [b, a] }, CATALOG)).toMatch(/does not match/)
		expect(answerProblem(p, { action: 'make', chosenBy: 'person', items: [a] }, CATALOG)).toMatch(/does not match/)
		expect(answerProblem({ ...p, status: 'made' }, { action: 'decline' }, CATALOG)).toMatch(/already answered/)
		expect(answerProblem(p, { action: 'make', chosenBy: 'person', items: [{ ...a, prompt: '' }, b] }, CATALOG)).toMatch(/Voice-over: Say what/)
	})
})

describe('You choose for me', () => {
	it('is what the assistant proposed, with Auto replaced by its pick and named models kept', () => {
		expect(assistantChoices(proposal()).map((r) => r.model)).toEqual(['eleven_multilingual_v2', 'music_v2'])
	})
})

describe('the cost of a proposal', () => {
	it('adds the items up, and says nothing when one cannot be priced yet', () => {
		const choices = assistantChoices(proposal())
		// 13 characters at 0.4, and music_v2 has no learned rate.
		expect(proposalCredits(choices, CATALOG)).toBeNull()
		const priced = [choices[0], { ...choices[1], model: 'music_v2_5' }]
		expect(proposalCredits(priced, CATALOG)).toBe(Math.ceil(13 * 0.4) + 120)
	})
})

describe('the message an assistant gets when the answer came late', () => {
	it('lists what was made with the asset ids to place, and what failed', () => {
		const p = proposal({
			status: 'made', chosenBy: 'person',
			items: [
				{ ...proposal().items[0], result: { assetId: 'gen-1', name: 'Voice-over', lengthSec: 2.25 } },
				{ ...proposal().items[1], error: 'Out of credits.' }
			]
		})
		const text = followUpMessage(p)
		expect(text).toContain('- Intro: asset gen-1, 2.3 s')
		expect(text).toContain('- Music failed: Out of credits.')
		expect(text).toContain('placeAudio')
	})

	it('says not now, with the person’s note', () => {
		expect(followUpMessage(proposal({ status: 'declined', note: 'No music.' }))).toBe('I answered your audio proposal: not now. No music.')
	})
})
