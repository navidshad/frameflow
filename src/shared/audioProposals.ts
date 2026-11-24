import {
	CAPABILITY_LABEL, estimateCredits, isCapability, requestProblem, type AudioCapability, type GenerateRequest, type ProviderId
} from './audioProviders'
import type { ModelCatalog } from './audioModels'

/**
 * An assistant's proposal to make audio, and the person's answer.
 *
 * Generating costs money, so an AI does not just do it. It proposes: "a
 * voice-over of this line, and a calm music bed under it". The chat shows the
 * proposal as a form (model, voice, words, length, cost) with three answers:
 * Make it (as edited), You choose for me (the assistant's own picks), Not now.
 * Pressing one is the person's consent, so it is not held to the agent's spend
 * cap. When the person has said "Auto" (in Settings, or "don't ask again" for one
 * project), the same proposal is made at once and shown as a receipt.
 *
 * Main owns every proposal's state and does the generating; the renderer only
 * draws it and sends the answer. Pure here: the shapes, the checks, the words.
 */

/** What an AI may do with audio providers: nothing, propose and wait for a yes, or make what it proposes. */
export type AudioAccess = 'off' | 'ask' | 'auto'

export const AUDIO_ACCESS: readonly { value: AudioAccess; label: string; note: string }[] = [
	{ value: 'off', label: 'Off', note: 'Agents never use a provider. You can still make sounds in the Sound tab.' },
	{ value: 'ask', label: 'Ask first', note: 'Agents propose what to make, with model, voice and cost. Nothing is made until you press Make it.' },
	{ value: 'auto', label: 'Auto', note: 'Agents choose and make audio without asking, within the limits below. Each one shows what it cost.' }
]

export const isAudioAccess = (v: unknown): v is AudioAccess => v === 'off' || v === 'ask' || v === 'auto'

/**
 * The level in force for one project. Off in Settings wins over everything; a
 * project where the person ticked "Don't ask again" is Auto.
 */
export const effectiveAccess = (global: AudioAccess, projectAuto: boolean | undefined): AudioAccess =>
	global === 'off' ? 'off' : projectAuto ? 'auto' : global

/** The most items one proposal may hold: a form longer than this is not read. */
export const MAX_PROPOSAL_ITEMS = 6

export interface ProposalItem {
	/** What the assistant asked for. An empty model or voice means "let it be chosen". */
	request: GenerateRequest
	/** "Intro narration", "Music under the montage": what it is for, in a few words. */
	purpose?: string
	/** The assistant's reason for this model and voice, in a sentence the person reads. */
	why?: string
	/** The model "Auto" stands for on this item: the assistant's own pick, else FrameFlow's. */
	autoModel?: string
	/** Set once made: the audio asset in the project. */
	result?: { assetId: string; name: string; lengthSec?: number; model?: string; credits?: number | null }
	error?: string
}

export type ProposalStatus = 'open' | 'making' | 'made' | 'declined' | 'failed'

export interface AudioProposal {
	id: string
	threadId: string
	/** The chat turn of FrameFlow's own assistant, to show the card under; absent for an outside agent. */
	turnId?: string
	/** "Claude Code": who proposed it. */
	agent: string
	/** One line from the assistant: why these. */
	message?: string
	items: ProposalItem[]
	status: ProposalStatus
	/** Who settled the choices: the person (Make it), or the assistant (You choose for me, or Auto). */
	chosenBy?: 'person' | 'assistant'
	/** Made because the project or Settings said Auto: nobody was asked. */
	auto?: boolean
	/** The assistant had stopped waiting when the answer came: it is told in a follow-up message. */
	late?: boolean
	note?: string
	createdAt: number
}

/** What the person pressed. `items` are the requests as the form left them (Make it). */
export type ProposalAnswer =
	| { action: 'make'; items: GenerateRequest[]; chosenBy: 'person' | 'assistant'; remember?: boolean }
	| { action: 'decline'; note?: string }

// ===== Checks =====

/** What an assistant sent for one item, before it is trusted. */
export interface ProposedItemInput {
	capability?: unknown
	prompt?: unknown
	model?: unknown
	voice?: unknown
	durationSec?: unknown
	instrumental?: unknown
	loop?: unknown
	purpose?: unknown
	why?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * An assistant's item → a request, or the reason it cannot be one. `provider`
 * is the connected provider that makes this kind (picked by the caller).
 */
export function itemFromInput(
	input: ProposedItemInput, provider: ProviderId, catalog: ModelCatalog | null
): { item: ProposalItem } | { problem: string } {
	if (!isCapability(input.capability)) return { problem: 'capability must be speech, sfx or music.' }
	const capability = input.capability as AudioCapability
	const request: GenerateRequest = {
		provider, capability, prompt: typeof input.prompt === 'string' ? input.prompt : '',
		...(str(input.model) ? { model: str(input.model) } : {}),
		...(capability === 'speech' && str(input.voice) ? { voice: str(input.voice) } : {}),
		...(capability !== 'speech' && typeof input.durationSec === 'number' ? { durationSec: input.durationSec } : {}),
		...(capability === 'music' && input.instrumental === false ? { instrumental: false } : {}),
		...(capability === 'sfx' && input.loop === true ? { loop: true } : {})
	}
	const problem = requestProblem(request, catalog)
	if (problem) return { problem }
	const purpose = str(input.purpose)
	const why = str(input.why)
	return { item: { request, ...(purpose ? { purpose: purpose.slice(0, 60) } : {}), ...(why ? { why: why.slice(0, 240) } : {}) } }
}

/**
 * Whether an answer can be acted on: an open proposal, the same number of items,
 * each the same kind and provider it was proposed as, and each one makeable.
 */
export function answerProblem(proposal: AudioProposal, answer: ProposalAnswer, catalog: ModelCatalog | null): string | null {
	if (proposal.status !== 'open') return 'That proposal was already answered.'
	if (answer.action === 'decline') return null
	if (answer.items.length !== proposal.items.length) return 'The answer does not match the proposal.'
	for (const [i, req] of answer.items.entries()) {
		const asked = proposal.items[i].request
		if (req.capability !== asked.capability || req.provider !== asked.provider) return 'The answer does not match the proposal.'
		const problem = requestProblem(req, catalog)
		if (problem) return `${CAPABILITY_LABEL[req.capability]}: ${problem}`
	}
	return null
}

/** "You choose for me": every item as the assistant proposed it, with Auto resolved to its pick. */
export const assistantChoices = (proposal: AudioProposal): GenerateRequest[] =>
	proposal.items.map((i) => ({ ...i.request, ...(i.request.model || !i.autoModel ? {} : { model: i.autoModel }) }))

/** About how many credits the whole proposal uses; null when any item's rate is not known yet. */
export function proposalCredits(requests: GenerateRequest[], catalog: ModelCatalog | null): number | null {
	let total = 0
	for (const r of requests) {
		const c = estimateCredits(r, catalog)
		if (c === null) return null
		total += c
	}
	return total
}

// ===== Words =====

/**
 * What the assistant is told when the answer came after it stopped waiting:
 * the next chat message, so it can place what was made.
 */
export function followUpMessage(p: AudioProposal): string {
	if (p.status === 'declined') return `I answered your audio proposal: not now.${p.note ? ` ${p.note}` : ''}`
	const made = p.items.filter((i) => i.result)
	const lines = made.map((i) => {
		const r = i.result!
		const len = r.lengthSec ? `, ${r.lengthSec.toFixed(1)} s` : ''
		return `- ${i.purpose ?? CAPABILITY_LABEL[i.request.capability]}: asset ${r.assetId}${len}`
	})
	const failed = p.items.filter((i) => i.error).map((i) => `- ${i.purpose ?? CAPABILITY_LABEL[i.request.capability]} failed: ${i.error}`)
	return [
		`I answered your audio proposal${p.chosenBy === 'assistant' ? ' (you choose)' : ''}. Made:`,
		...lines, ...failed,
		made.length ? 'Place them as you planned (apply_ops placeAudio).' : ''
	].filter(Boolean).join('\n')
}
