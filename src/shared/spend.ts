import type { UsageRecord } from './types'

/**
 * What a project has spent, in each provider's own unit.
 *
 * Providers bill differently, and adding them into one dollar figure was wrong:
 * the Gemini API bills dollars per token; ElevenLabs bills credits from a plan;
 * Claude Code runs on the person's own Claude plan and bills nothing here. So
 * spend is kept per meter and shown per meter ("$0.09 · 193 credits · Claude on
 * plan"), with a line per provider for the details.
 *
 * Reads the project's usage records, old ones included: a record from before
 * meters existed is read by its `source`.
 */

export type Meter = 'usd' | 'credits' | 'plan'

export interface SpendLine {
	/** "Gemini API", "ElevenLabs", "Claude Code". */
	label: string
	meter: Meter
	/** Dollars for usd, credits for credits; 0 for plan. */
	amount: number
	/** How many calls, generations or turns. */
	count: number
	/** Calls whose amount is not known (made before FrameFlow counted credits). */
	uncounted?: number
}

export interface SpendSummary {
	usd: number
	credits: number
	planTurns: number
	lines: SpendLine[]
}

/** Where a record's spend belongs. */
function lineOf(r: UsageRecord): { key: string; label: string; meter: Meter } {
	const source = r.source ?? ''
	if (r.plan || source.startsWith('engine:claude')) return { key: 'claude', label: 'Claude Code', meter: 'plan' }
	if (source === 'audio:elevenlabs') return { key: 'elevenlabs', label: 'ElevenLabs', meter: 'credits' }
	if (source === 'audio:gemini') return { key: 'gemini-voices', label: 'Gemini voices', meter: 'usd' }
	if (source === 'search') return { key: 'search', label: 'Web search (Gemini)', meter: 'usd' }
	return { key: 'gemini', label: 'Gemini API', meter: 'usd' }
}

export function summarizeSpend(records: UsageRecord[] | undefined): SpendSummary {
	const lines = new Map<string, SpendLine>()
	for (const r of records ?? []) {
		const at = lineOf(r)
		const line = lines.get(at.key) ?? { label: at.label, meter: at.meter, amount: 0, count: 0 }
		line.count++
		if (at.meter === 'usd') line.amount += Number.isFinite(r.cost) ? r.cost : 0
		else if (at.meter === 'credits') {
			// An older record kept a dollar guess instead of credits: it is counted, not priced.
			if (typeof r.credits === 'number' && Number.isFinite(r.credits)) line.amount += r.credits
			else line.uncounted = (line.uncounted ?? 0) + 1
		}
		lines.set(at.key, line)
	}
	const all = [...lines.values()]
	return {
		usd: all.filter((l) => l.meter === 'usd').reduce((n, l) => n + l.amount, 0),
		credits: all.filter((l) => l.meter === 'credits').reduce((n, l) => n + l.amount, 0),
		planTurns: all.filter((l) => l.meter === 'plan').reduce((n, l) => n + l.count, 0),
		lines: all
	}
}

/** "$0.0882", "$1.25". Small amounts keep four places, as the header always showed. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(usd < 1 ? 4 : 2)}`

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The header's short form: one part per meter that was used. */
export function spendParts(s: SpendSummary): string[] {
	const parts: string[] = []
	if (s.usd > 0) parts.push(formatUsd(s.usd))
	// Only counted credits make the short form; older uncounted ones are in the breakdown.
	if (s.credits > 0) parts.push(plural(Math.round(s.credits), 'credit'))
	if (s.planTurns > 0) parts.push('Claude on plan')
	return parts
}

/** One line per provider, for the tooltip and the breakdown. */
export function describeLine(l: SpendLine): string {
	if (l.meter === 'plan') return `${l.label}: ${plural(l.count, 'turn')} on your Claude plan, not billed here`
	if (l.meter === 'credits') {
		const uncounted = l.uncounted ?? 0
		if (uncounted === l.count) return `${l.label}: ${plural(l.count, 'generation')}, made before credits were counted`
		const counted = `${plural(Math.round(l.amount), 'credit')} for ${plural(l.count - uncounted, 'generation')}`
		return `${l.label}: ${counted}${uncounted ? `, and ${uncounted} made before credits were counted` : ''}`
	}
	return `${l.label}: ${formatUsd(l.amount)} for ${plural(l.count, 'call')}`
}
