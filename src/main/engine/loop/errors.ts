import { APICallError } from 'ai'
import { readableError } from '@shared/engines'

/**
 * A model call that failed, in words the chat can show. `note` is set when the
 * user must fix something outside FrameFlow (a rejected key), as for a CLI's
 * sign-in; a rate limit or an outage is only worth saying and trying again.
 */
export interface LoopFailure {
	error: string
	note?: string
}

const status = (error: unknown): number | undefined => {
	if (APICallError.isInstance(error)) return error.statusCode
	const code = (error as { statusCode?: unknown; status?: unknown } | null)
	const n = Number(code?.statusCode ?? code?.status)
	return Number.isFinite(n) ? n : undefined
}

export function loopFailure(error: unknown, label: string, modelName: string): LoopFailure {
	const raw = String((error as { message?: unknown })?.message ?? error ?? '')
	const body = APICallError.isInstance(error) && typeof error.responseBody === 'string' ? readableError(error.responseBody) : ''
	const detail = (body || readableError(raw) || raw).replace(/\s+/g, ' ').trim().slice(0, 300)
	switch (status(error)) {
		case 401: case 403: {
			const note = `${label} rejected the API key. Check it in Settings.`
			return { error: note, note }
		}
		case 404: return { error: `${label} has no model called ${modelName}. Pick another in the engine menu. ${detail}`.trim() }
		case 429: return { error: `${label} is rate limiting this key right now. Wait a moment and try again. ${detail}`.trim() }
		case 400: return { error: `${label} refused the request: ${detail}` }
		default:
			if (status(error) !== undefined && status(error)! >= 500) return { error: `${label} is having trouble (${status(error)}). Try again in a moment. ${detail}`.trim() }
			if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(raw)) return { error: `Could not reach ${label}. Check the connection and try again.` }
			return { error: detail || `${label} failed.` }
	}
}
