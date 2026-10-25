import type { MediaAsset } from './types'

/**
 * Where a media file's preparation stands, as people and agents should hear it.
 *
 * The document stores `preprocessState: 'running'` while the chain works and
 * keeps it if the app quits mid-chain: nothing resumes the work at launch, so
 * the file would read "running" forever. Main knows which chains are live;
 * a stored 'running' with no live chain is 'interrupted' (Retry in the Media panel).
 */
export type PrepStatus = 'pending' | 'running' | 'interrupted' | 'completed' | 'error'

export function prepStatus(state: MediaAsset['preprocessState'] | undefined, live: boolean): PrepStatus {
	if (state === 'running' && !live) return 'interrupted'
	return state || 'pending'
}

/**
 * Whether the timeline should ask for an asset's filmstrip now. A strip needs
 * only a picture to read frames from (the proxy, or the original once the
 * chain has finished), never the transcript or the scenes: one slow or
 * interrupted step must not leave a clip blank on the timeline. A live chain
 * draws the strip itself right after the proxy, so it is not asked twice.
 */
export function wantsFilmstrip(asset: Pick<MediaAsset, 'kind' | 'preprocessState' | 'proxyPath' | 'filmstrip'>, opts: {
	usedOnTimeline: boolean
	live: boolean
	alreadyRequested: boolean
}): boolean {
	if (asset.kind !== 'video' || !opts.usedOnTimeline || opts.alreadyRequested) return false
	if (asset.filmstrip?.length) return false
	if (opts.live) return false
	return !!asset.proxyPath || asset.preprocessState === 'completed'
}
