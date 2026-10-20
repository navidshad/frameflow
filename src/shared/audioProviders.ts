/**
 * Where a sound or a voice can come from besides the built-in synth.
 *
 * A provider makes audio from a prompt: a voice reading a line, a sound effect
 * described in words, a music bed. It costs money and needs a key, so it is
 * never the default and never silent: every generation is shown with what it
 * cost, and an agent needs its own permission (off by default) with a cap per
 * turn before it can spend anything.
 *
 * The rule that keeps this safe: **a generated sound is made once, then it is a
 * file.** The result is an ordinary audio asset that remembers where it came
 * from (`AudioProvenance`). Export never calls the network; undo works; the
 * provider can change or vanish later and the project still plays.
 *
 * Pure: the capability table, request checks, provenance, and the spend rule.
 * The network calls live in `main/audio/`.
 */

export type ProviderId = 'gemini' | 'elevenlabs'
export type AudioCapability = 'speech' | 'sfx' | 'music'

export interface ProviderInfo {
	id: ProviderId
	label: string
	capabilities: readonly AudioCapability[]
	/** What the provider needs from the user, in the words Settings uses. */
	needs: string
	/** Shown under its name in Settings. */
	note: string
}

export const PROVIDERS: readonly ProviderInfo[] = [
	{
		id: 'gemini', label: 'Gemini voices', capabilities: ['speech'],
		needs: 'your Gemini API key', note: 'Voice-over from text. Uses the key you already saved, and is billed per token.'
	},
	{
		id: 'elevenlabs', label: 'ElevenLabs', capabilities: ['speech', 'sfx', 'music'],
		needs: 'its own API key', note: 'Voices, sound effects from a prompt, and music. Uses your ElevenLabs plan’s credits.'
	}
]

export const providerInfo = (id: string): ProviderInfo | undefined => PROVIDERS.find((p) => p.id === id)
export const isProviderId = (id: unknown): id is ProviderId => PROVIDERS.some((p) => p.id === id)
export const isCapability = (value: unknown): value is AudioCapability =>
	value === 'speech' || value === 'sfx' || value === 'music'

export const CAPABILITY_LABEL: Record<AudioCapability, string> = {
	speech: 'Voice-over', sfx: 'Sound effect', music: 'Music'
}

// ===== Requests =====

export interface GenerateRequest {
	provider: ProviderId
	capability: AudioCapability
	/** The line to speak, or a description of the sound or music. */
	prompt: string
	/** A voice id or name, for speech. */
	voice?: string
	/** How long, for sound effects and music. Absent lets the provider choose. */
	durationSec?: number
}

/** The longest line a single voice-over request takes, and the bounds on effects and music. */
export const LIMITS = {
	speechChars: { min: 1, max: 4000 },
	promptChars: { min: 3, max: 450 },
	sfxSec: { min: 0.5, max: 30 },
	musicSec: { min: 3, max: 120 }
} as const

/** Why a request cannot be made, in a sentence the person (or the agent) can act on; null when fine. */
export function requestProblem(req: GenerateRequest): string | null {
	const info = providerInfo(req.provider)
	if (!info) return `Unknown provider "${String(req.provider)}". Providers: ${PROVIDERS.map((p) => p.id).join(', ')}.`
	if (!isCapability(req.capability)) return `Unknown kind "${String(req.capability)}": speech, sfx or music.`
	if (!info.capabilities.includes(req.capability)) {
		const who = PROVIDERS.filter((p) => p.capabilities.includes(req.capability)).map((p) => p.label).join(' or ')
		return `${info.label} does not make ${CAPABILITY_LABEL[req.capability].toLowerCase()}${who ? `; ${who} does` : ''}.`
	}
	const text = (req.prompt ?? '').trim()
	if (req.capability === 'speech') {
		if (text.length < LIMITS.speechChars.min) return 'Say what the voice should read.'
		if (text.length > LIMITS.speechChars.max) return `That line is ${text.length} characters; a single voice-over takes at most ${LIMITS.speechChars.max}. Split it.`
	} else {
		if (text.length < LIMITS.promptChars.min) return 'Describe the sound in a few words.'
		if (text.length > LIMITS.promptChars.max) return `That description is ${text.length} characters; keep it under ${LIMITS.promptChars.max}.`
		const range = req.capability === 'sfx' ? LIMITS.sfxSec : LIMITS.musicSec
		if (req.durationSec !== undefined && (!Number.isFinite(req.durationSec) || req.durationSec < range.min || req.durationSec > range.max)) {
			return `A ${CAPABILITY_LABEL[req.capability].toLowerCase()} runs ${range.min} to ${range.max} seconds.`
		}
	}
	return null
}

// ===== Provenance =====

/**
 * Where a generated sound came from, kept with the asset: enough to see what it
 * was and what it cost, and to make another take, without the provider.
 */
export interface AudioProvenance {
	provider: ProviderId
	capability: AudioCapability
	prompt: string
	voice?: string
	model?: string
	/** What it cost in USD, when the provider tells us; null when it bills in credits we cannot price. */
	costUsd: number | null
	/** One line about the cost, for the cases where there is no number ("12 credits"). */
	costNote?: string
	madeAt: number
}

// ===== Spending =====

/**
 * What an agent may spend in one turn. Generating is the one thing an agent can
 * do that costs money, so it is bounded twice: by how many things it makes and
 * by how much they cost. A person pressing Generate in the Sound tab is not
 * bound by this: they see the cost and chose to.
 */
export interface SpendPolicy {
	maxGenerationsPerTurn: number
	/** Null means no dollar cap (only the count). */
	maxUsdPerTurn: number | null
}

export const DEFAULT_SPEND_POLICY: SpendPolicy = { maxGenerationsPerTurn: 3, maxUsdPerTurn: 1 }

export function normalizeSpendPolicy(value: unknown): SpendPolicy {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<SpendPolicy>
	const count = typeof v.maxGenerationsPerTurn === 'number' && Number.isFinite(v.maxGenerationsPerTurn)
		? Math.max(0, Math.min(50, Math.floor(v.maxGenerationsPerTurn)))
		: DEFAULT_SPEND_POLICY.maxGenerationsPerTurn
	const usd = v.maxUsdPerTurn === null ? null
		: typeof v.maxUsdPerTurn === 'number' && Number.isFinite(v.maxUsdPerTurn) ? Math.max(0, v.maxUsdPerTurn)
			: DEFAULT_SPEND_POLICY.maxUsdPerTurn
	return { maxGenerationsPerTurn: count, maxUsdPerTurn: usd }
}

export interface Spent { count: number; usd: number }

/**
 * Whether one more generation fits under the policy. `estimateUsd` is what the
 * request would cost if the provider prices it; null (a credit-billed provider)
 * is counted against the count only, and the caller says so.
 */
export function spendDecision(
	policy: SpendPolicy, spent: Spent, estimateUsd: number | null
): { ok: true } | { ok: false; reason: string } {
	if (spent.count >= policy.maxGenerationsPerTurn) {
		return {
			ok: false,
			reason: `That is the limit: ${policy.maxGenerationsPerTurn} generation${policy.maxGenerationsPerTurn === 1 ? '' : 's'} per turn ` +
				'(Settings → Audio providers). Tell the user what you would make and let them raise it, or make it from the Sound tab.'
		}
	}
	if (policy.maxUsdPerTurn !== null && estimateUsd !== null && spent.usd + estimateUsd > policy.maxUsdPerTurn + 1e-9) {
		return {
			ok: false,
			reason: `That would bring this turn to about $${(spent.usd + estimateUsd).toFixed(2)}, over the $${policy.maxUsdPerTurn.toFixed(2)} limit ` +
				'(Settings → Audio providers). Ask the user, or make it shorter.'
		}
	}
	return { ok: true }
}

/** "$0.04", "under a cent", or the provider's own words when it cannot be priced. */
export function formatCost(p: Pick<AudioProvenance, 'costUsd' | 'costNote'>): string {
	if (p.costUsd === null || p.costUsd === undefined) return p.costNote || 'cost not reported'
	if (p.costUsd < 0.005) return 'under a cent'
	return `$${p.costUsd.toFixed(2)}`
}

// ===== Settings =====

export interface AudioProviderSettings {
	/** Gemini voices use the Gemini key already saved: this is only whether to offer them. */
	geminiVoices: boolean
	spend: SpendPolicy
}

export const DEFAULT_AUDIO_SETTINGS: AudioProviderSettings = { geminiVoices: false, spend: DEFAULT_SPEND_POLICY }

export function normalizeAudioSettings(value: unknown): AudioProviderSettings {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<AudioProviderSettings>
	return { geminiVoices: v.geminiVoices === true, spend: normalizeSpendPolicy(v.spend) }
}

/** What Settings and the Sound tab need to know about one provider, with no secret in it. */
export interface ProviderStatus {
	id: ProviderId
	label: string
	capabilities: readonly AudioCapability[]
	note: string
	needs: string
	/** Ready to use: a key is saved (and, for Gemini, the voices are switched on). */
	connected: boolean
	/** A key is saved (for ElevenLabs), or the Gemini key exists (for Gemini). */
	keySaved: boolean
}
