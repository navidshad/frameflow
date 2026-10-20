import type { AudioCapability, GenerateRequest, ProviderId } from '../../shared/audioProviders'

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
}

export interface Voice {
	id: string
	name: string
	/** "female, American, warm" and the like, when the provider says. */
	description?: string
	previewUrl?: string
}

export interface AudioProviderImpl {
	id: ProviderId
	capabilities: readonly AudioCapability[]
	/** A rough price before the call, in USD, or null when it cannot be priced. Used for the spend cap. */
	estimateUsd(req: GenerateRequest): number | null
	generate(req: GenerateRequest, ctx: ProviderContext): Promise<ProviderOutput>
	voices?(ctx: ProviderContext): Promise<Voice[]>
}

/** A provider said no, in words fit for the person: a bad key, a quota, a rate limit. */
export class ProviderError extends Error {
	constructor(message: string, readonly status?: number, readonly kind: 'auth' | 'quota' | 'rate' | 'input' | 'other' = 'other') {
		super(message)
	}
}
