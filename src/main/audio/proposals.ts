import { randomUUID } from 'node:crypto'
import {
	answerProblem, type AudioProposal, type ProposalAnswer, type ProposalItem
} from '../../shared/audioProposals'
import type { ModelCatalog } from '../../shared/audioModels'
import type { GenerateRequest, ProviderId } from '../../shared/audioProviders'
import type { Generated } from './generate'

/**
 * Every open proposal, and the one place they are answered.
 *
 * A proposal's state lives here, in main: the renderer draws whatever it is
 * sent (`publish`) and sends back what the person pressed. Answering does the
 * generating, item by item, publishing each step, so the card shows "Making…"
 * and then what was made, whether or not the assistant is still waiting. An
 * assistant waits with `wait`, like the `wait` tool: it returns once the
 * proposal is settled or the time is up, and a later answer is still honoured
 * (`late`, so the chat can tell the assistant in its next message).
 *
 * No Electron and no network: both come in through `deps`.
 */

export interface ProposalBookDeps {
	/** Show the proposal's current state in the chat. */
	publish(proposal: AudioProposal): void
	generate(threadId: string, req: GenerateRequest): Promise<Generated>
	catalog(provider: ProviderId): Promise<ModelCatalog | null>
	/** "Don't ask again in this project": the project is Auto from now on. */
	rememberAuto(threadId: string): void
	now?: () => number
}

export interface ProposalBook {
	open(draft: Omit<AudioProposal, 'id' | 'status' | 'createdAt'>): AudioProposal
	get(id: string): AudioProposal | undefined
	/** Until the proposal is settled (made, declined, failed) or `timeoutMs` passes; the state at that moment. */
	wait(id: string, timeoutMs: number, onTick?: (waitedMs: number) => void): Promise<AudioProposal | undefined>
	/** Act on an answer. Throws with a reason when it cannot be acted on. */
	answer(id: string, answer: ProposalAnswer, options?: { auto?: boolean }): Promise<AudioProposal>
}

/** Old proposals are dropped past this many: the cards are a conversation, not a store. */
const KEEP = 100
const TICK_MS = 1000

export function createProposalBook(deps: ProposalBookDeps): ProposalBook {
	const now = deps.now ?? Date.now
	const proposals = new Map<string, AudioProposal>()
	const listeners = new Map<string, Set<() => void>>()

	const settled = (p: AudioProposal) => p.status === 'made' || p.status === 'declined' || p.status === 'failed'
	const update = (next: AudioProposal) => {
		proposals.set(next.id, next)
		deps.publish(next)
		for (const fn of listeners.get(next.id) ?? []) fn()
	}

	return {
		open(draft) {
			const p: AudioProposal = { ...draft, id: `prop-${randomUUID().slice(0, 8)}`, status: 'open', createdAt: now() }
			proposals.set(p.id, p)
			if (proposals.size > KEEP) proposals.delete(proposals.keys().next().value!)
			deps.publish(p)
			return p
		},

		get: (id) => proposals.get(id),

		wait(id, timeoutMs, onTick) {
			const start = now()
			return new Promise((resolve) => {
				const current = proposals.get(id)
				if (!current || settled(current) || timeoutMs <= 0) return resolve(current)
				let ticker: ReturnType<typeof setInterval> | undefined
				let timer: ReturnType<typeof setTimeout> | undefined
				const set = listeners.get(id) ?? new Set<() => void>()
				listeners.set(id, set)
				const done = () => {
					clearInterval(ticker)
					clearTimeout(timer)
					set.delete(check)
					if (!set.size) listeners.delete(id)
					resolve(proposals.get(id))
				}
				const check = () => { const p = proposals.get(id); if (!p || settled(p)) done() }
				set.add(check)
				timer = setTimeout(done, timeoutMs)
				if (onTick) ticker = setInterval(() => onTick(now() - start), TICK_MS)
			})
		},

		async answer(id, answer, options = {}) {
			const p = proposals.get(id)
			if (!p) throw new Error('That proposal is gone: the app was restarted, or it is too old.')
			const provider = p.items[0]?.request.provider
			const catalog = provider ? await deps.catalog(provider) : null
			const problem = answerProblem(p, answer, catalog)
			if (problem) throw new Error(problem)
			// Nobody waiting: the assistant has moved on, and hears of it in the next message.
			const late = !options.auto && !listeners.get(id)?.size

			if (answer.action === 'decline') {
				const next: AudioProposal = { ...p, status: 'declined', late, ...(answer.note ? { note: answer.note } : {}) }
				update(next)
				return next
			}

			if (answer.remember) deps.rememberAuto(p.threadId)
			let items: ProposalItem[] = p.items.map((item, i) => ({ ...item, request: answer.items[i] }))
			update({ ...p, items, status: 'making', chosenBy: answer.chosenBy, late, ...(options.auto ? { auto: true } : {}) })

			// One at a time, each shown as it lands: a failure keeps what was made before it.
			for (let i = 0; i < items.length; i++) {
				let made: ProposalItem
				try {
					const { asset, provenance } = await deps.generate(p.threadId, items[i].request)
					made = {
						...items[i],
						result: {
							assetId: asset.id, name: asset.name,
							...(asset.metadata?.duration ? { lengthSec: asset.metadata.duration } : {}),
							...(provenance.model ? { model: provenance.model } : {}),
							credits: provenance.credits ?? null
						}
					}
				} catch (error) {
					made = { ...items[i], error: (error as Error).message || 'It could not be made.' }
				}
				items = items.map((x, j) => (j === i ? made : x))
				update({ ...proposals.get(id)!, items })
			}
			const next: AudioProposal = { ...proposals.get(id)!, items, status: items.some((i) => i.result) ? 'made' : 'failed' }
			update(next)
			return next
		}
	}
}
