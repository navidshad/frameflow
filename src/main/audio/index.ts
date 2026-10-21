import type { ProviderId } from '../../shared/audioProviders'
import { elevenlabs } from './elevenlabs'
import { gemini } from './gemini'
import type { AudioProviderImpl } from './provider'

/** Every provider this build can talk to. A new one is a file and a line here. */
export const PROVIDER_IMPLS: Record<ProviderId, AudioProviderImpl> = { gemini, elevenlabs }

export { generateAudioAsset, generatedName } from './generate'
export type { GenerateDeps, GenerateStore, Generated } from './generate'
export { ProviderError } from './provider'
