import type { ModelCatalog } from '../../shared/audioModels'
import type { ProviderId } from '../../shared/audioProviders'

/**
 * The provider's model list, kept fresh and kept on disk.
 *
 * Asked at most once a day (or when someone presses Refresh), and the last good
 * answer is saved so the app still knows the models offline or when one of the
 * two sources fails. A failed refresh never empties a list that was there: it
 * keeps what it had and says what it could not read (`gaps`).
 *
 * It also learns what each model really costs. After every generation the
 * provider's own count (`character-cost`) divided by what was billed (characters,
 * or seconds) is that model's rate, saved with the list, so the next estimate
 * is the account's real price rather than a list price.
 *
 * Nothing here knows Electron or the network: both are injected, so it is tested
 * with a fake provider and an in-memory disk.
 */

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A list with a part missing (a permission, a network blip) is asked again sooner, but not on every use. */
export const CATALOG_GAP_RETRY_MS = 10 * 60 * 1000

/** One provider's way of asking for its models; `prior` is what is known already. */
export type FetchCatalog = (prior: ModelCatalog | null) => Promise<ModelCatalog>

export interface CatalogDeps {
	provider: ProviderId
	fetchCatalog: FetchCatalog
	/** The list saved last time, or null. */
	load(): ModelCatalog | null
	save(catalog: ModelCatalog): void
	now?: () => number
}

export interface CatalogStore {
	/** What is known now, however old. Never waits. */
	current(): ModelCatalog | null
	/** A fresh list: asks the provider when the saved one is older than a day (or `force`). */
	ensure(force?: boolean): Promise<ModelCatalog | null>
	/** Remember what a model was seen to cost per character or second. */
	learnRate(modelId: string, credits: number, units: number): void
	/** Forget the list (a new key may see other models), keeping nothing. */
	reset(): void
}

export function createCatalogStore(deps: CatalogDeps): CatalogStore {
	const now = deps.now ?? Date.now
	let current: ModelCatalog | null = null
	try { current = deps.load() } catch { current = null }
	let inflight: Promise<ModelCatalog | null> | null = null

	const persist = (next: ModelCatalog) => {
		current = next
		try { deps.save(next) } catch (error) { console.warn('[audio] could not save the model list:', (error as Error).message) }
	}

	return {
		current: () => current,

		ensure(force = false) {
			const maxAge = current?.gaps?.length ? CATALOG_GAP_RETRY_MS : CATALOG_MAX_AGE_MS
			const fresh = !!current && current.fetchedAt > 0 && now() - current.fetchedAt < maxAge
			if (fresh && !force) return Promise.resolve(current)
			// Two callers at once share one request.
			inflight ??= deps.fetchCatalog(current)
				.then((next) => {
					// Rates are learned here, not fetched: carry them over.
					persist({ ...next, rates: { ...(current?.rates ?? {}), ...(next.rates ?? {}) } })
					return current
				})
				.catch((error) => {
					console.warn('[audio] could not refresh the model list:', (error as Error).message)
					return current
				})
				.finally(() => { inflight = null })
			return inflight
		},

		learnRate(modelId, credits, units) {
			if (!current || !(units > 0) || !(credits >= 0) || !Number.isFinite(credits / units)) return
			persist({ ...current, rates: { ...(current.rates ?? {}), [modelId]: credits / units } })
		},

		reset() {
			current = null
		}
	}
}
