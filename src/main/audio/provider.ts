import type { AudioCapability, GenerateRequest, ProviderAccount, ProviderId, Voice } from '../../shared/audioProviders'
import type { ModelCatalog } from '../../shared/audioModels'

/**
 * What a provider's implementation looks like. The network is injected (`fetch`)
 * so each one is tested against a fake server, and nothing here touches Electron
 * or the project: it turns a request into audio bytes and says what it cost.
 */

export interface ProviderContext {
	fetch: typeof fetch
	/** The provider's API key. Never logged, never returned to the renderer. */
	key: string
	signal?: AbortSignal
	/** The provider's models as it listed them last, for one that publishes a list. */
	catalog?: ModelCatalog | null
}

/** Audio as the provider returned it. PCM is wrapped into a WAV by the caller. */
export interface ProviderOutput {
	bytes: Buffer
	format: 'mp3' | 'wav' | 'pcm16'
	/** For `pcm16`: how to read the samples. */
	sampleRate?: number
	channels?: number
	/** Which model made it, for the receipt. */
	model: string
	/** Priced when the provider says what it used; null when it bills in credits. */
	costUsd: number | null
	costNote?: string
	/** Provider credits used, when it bills in credits. */
	credits?: number | null
	/** `credits` is the provider's own count for this call, not an estimate: worth learning the rate from. */
	measured?: boolean
}

export type { Voice }

export interface AudioProviderImpl {
	id: ProviderId
	capabilities: readonly AudioCapability[]
	/** A rough price before the call, in USD, or null when it cannot be priced. Used for the spend cap. */
	estimateUsd(req: GenerateRequest, catalog?: ModelCatalog | null): number | null
	generate(req: GenerateRequest, ctx: ProviderContext): Promise<ProviderOutput>
	voices?(ctx: ProviderContext): Promise<Voice[]>
	/** What the account has left this period. Free to ask; absent for a provider that bills per token. */
	account?(ctx: ProviderContext): Promise<ProviderAccount>
	/** Which models it offers today, for a provider that says. `prior` is kept for whatever cannot be read now. */
	catalog?(ctx: ProviderContext, prior: ModelCatalog | null): Promise<ModelCatalog>
	/** The provider's own page about its models, as text an agent can read (markdown). */
	docsUrl?: string
}

/** A provider said no, in words fit for the person: a bad key, a quota, a rate limit. */
export class ProviderError extends Error {
	constructor(message: string, readonly status?: number, readonly kind: 'auth' | 'quota' | 'rate' | 'input' | 'other' = 'other') {
		super(message)
	}
}
