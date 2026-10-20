import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { MediaAsset, UsageRecord } from '../../shared/types'
import {
	CAPABILITY_LABEL, providerInfo, requestProblem, type AudioProvenance, type GenerateRequest, type ProviderId
} from '../../shared/audioProviders'
import { ProviderError, type AudioProviderImpl } from './provider'
import { wavFromPcm16 } from './wav'

/**
 * Make a sound with a provider, once, and keep it as a file.
 *
 * The whole point of the shape: the network call happens here and nowhere else.
 * What comes back is written into the project as an ordinary audio asset with a
 * receipt (`generated`), so the sound plays, exports and undoes like any other,
 * with no provider and no connection. Everything the project needs to know about
 * the outside world is injected, so this is tested with a fake provider and a
 * temp folder rather than a real key.
 */

export interface GenerateStore {
	/** The project's working folder, or null when the project is gone. */
	tempDir(threadId: string): string | null
	addAsset(threadId: string, options: { sourcePath: string; name: string; assetId: string }): Promise<MediaAsset | null>
	patchAsset(threadId: string, assetId: string, patch: Partial<MediaAsset>): Promise<unknown>
	addUsage(threadId: string, record: UsageRecord): Promise<unknown>
	getAsset(threadId: string, assetId: string): MediaAsset | null
}

export interface GenerateDeps {
	providers: Partial<Record<ProviderId, AudioProviderImpl>>
	/** The key for a provider, or undefined when it is not connected. */
	keyFor(id: ProviderId): string | undefined
	store: GenerateStore
	fetch?: typeof fetch
	now?: () => number
}

export interface Generated {
	asset: MediaAsset
	provenance: AudioProvenance
}

/** A short, readable name for the asset: the kind and the start of what was asked. */
export function generatedName(req: GenerateRequest): string {
	const text = req.prompt.replace(/\s+/g, ' ').trim()
	const head = text.length > 36 ? `${text.slice(0, 34).trimEnd()}…` : text
	return `${CAPABILITY_LABEL[req.capability]}: ${head}`
}

export async function generateAudioAsset(
	threadId: string, req: GenerateRequest, deps: GenerateDeps, signal?: AbortSignal
): Promise<Generated> {
	const problem = requestProblem(req)
	if (problem) throw new ProviderError(problem, undefined, 'input')

	const info = providerInfo(req.provider)!
	const impl = deps.providers[req.provider]
	if (!impl) throw new ProviderError(`${info.label} is not available in this build.`)
	const key = deps.keyFor(req.provider)
	if (!key) {
		throw new ProviderError(`${info.label} is not connected. Add ${info.needs} in Settings → Audio providers.`, undefined, 'auth')
	}
	const dir = deps.store.tempDir(threadId)
	if (!dir) throw new ProviderError('That project is not open any more.')

	const out = await impl.generate(req, { fetch: deps.fetch ?? fetch, key, signal })

	// Files first, then the project: a failure past this point leaves a file on
	// disk but no half-made asset.
	const id = randomUUID().replace(/-/g, '').slice(0, 16)
	const folder = path.join(dir, 'generated')
	fs.mkdirSync(folder, { recursive: true })
	const ext = out.format === 'mp3' ? 'mp3' : 'wav'
	const file = path.join(folder, `${id}.${ext}`)
	const bytes = out.format === 'pcm16' ? wavFromPcm16(out.bytes, out.sampleRate ?? 24000, out.channels ?? 1) : out.bytes
	fs.writeFileSync(file, bytes)

	const provenance: AudioProvenance = {
		provider: req.provider, capability: req.capability, prompt: req.prompt.trim(),
		...(req.voice ? { voice: req.voice } : {}),
		model: out.model, costUsd: out.costUsd, ...(out.costNote ? { costNote: out.costNote } : {}),
		madeAt: (deps.now ?? Date.now)()
	}

	const assetId = `gen-${id}`
	const created = await deps.store.addAsset(threadId, { sourcePath: file, name: generatedName(req), assetId })
	if (!created) throw new ProviderError('The sound was made but could not be added to the project.')
	await deps.store.patchAsset(threadId, assetId, { preprocessState: 'completed', generated: provenance })
	if (out.costUsd !== null && out.costUsd > 0) {
		await deps.store.addUsage(threadId, {
			usage: { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
			cost: out.costUsd, timestamp: provenance.madeAt, source: `audio:${req.provider}`
		})
	}
	const asset = deps.store.getAsset(threadId, assetId) ?? { ...created, preprocessState: 'completed' as const, generated: provenance }
	return { asset, provenance }
}
