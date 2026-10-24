/**
 * First-launch setup: what "set up" means, how a key test answer reads, and the
 * "Before you start" list. Pure, so the router guard, main and the wizard agree
 * and the rules have tests. main/setup/* does the file system and the network.
 */

export interface SetupFacts {
	/** A Gemini key is saved. */
	hasKey: boolean
	/** The projects folder is inside the system temp folder. */
	tempUnsafe: boolean
	/**
	 * The stored flag. Absent for anyone who set the app up before the wizard
	 * existed, who must not be sent through it: only an explicit `false` forces it.
	 */
	flag?: boolean
}

/** Set up = a key, and a folder the OS will not clear. */
export const isSetupComplete = ({ hasKey, tempUnsafe, flag }: SetupFacts): boolean =>
	hasKey && !tempUnsafe && flag !== false

export interface KeyTestResult { ok: boolean; error?: string }

/** Google answers a bad key with 400 "API key not valid"; a 403 means the key exists but may not use the API. */
export function classifyGeminiKeyResponse(status: number, bodyText: string): KeyTestResult {
	if (status >= 200 && status < 300) return { ok: true }
	let message = ''
	try { message = JSON.parse(bodyText)?.error?.message ?? '' } catch { /* not JSON */ }
	if (status === 400 || status === 401 || /API key not valid|API_KEY_INVALID/i.test(message)) {
		return { ok: false, error: 'Google does not accept this key. Check that you copied all of it.' }
	}
	if (status === 403) return { ok: false, error: 'This key is not allowed to use the Gemini API. Create one in Google AI Studio.' }
	if (status === 429) return { ok: false, error: 'Google says this key is out of quota right now. Try again in a minute.' }
	return { ok: false, error: message || `Google answered with status ${status}.` }
}

/** "/Users/ada/Movies/FrameFlow" → "~/Movies/FrameFlow". */
export function tildePath(path: string, home: string): string {
	if (!home) return path
	if (path === home) return '~'
	return path.startsWith(home + '/') || path.startsWith(home + '\\') ? '~' + path.slice(home.length) : path
}

export interface CheckRow { id: string; label: string; detail: string; state: 'ok' | 'off' | 'bad' }

export interface CheckInput {
	ffmpeg: { available: boolean; version?: string }
	folder: string
	folderWritable: boolean
	geminiKeyOk: boolean
	elevenLabsKey: boolean
}

export function buildChecks(i: CheckInput): CheckRow[] {
	return [
		i.ffmpeg.available
			? { id: 'ffmpeg', label: 'FFmpeg', detail: i.ffmpeg.version ? `bundled · ${i.ffmpeg.version}` : 'bundled', state: 'ok' }
			: { id: 'ffmpeg', label: 'FFmpeg', detail: 'not found. Video cannot be processed', state: 'bad' },
		{ id: 'folder', label: 'Projects folder can be written', detail: i.folder, state: i.folderWritable ? 'ok' : 'bad' },
		i.geminiKeyOk
			? { id: 'gemini', label: 'Gemini key answered a test call', detail: 'ok', state: 'ok' }
			: { id: 'gemini', label: 'Gemini key answered a test call', detail: 'not checked', state: 'bad' },
		i.elevenLabsKey
			? { id: 'audio', label: 'Generated audio', detail: 'on, with your ElevenLabs key', state: 'ok' }
			: { id: 'audio', label: 'Generated audio', detail: 'off until an ElevenLabs key is added', state: 'off' }
	]
}

/** Blocks Start: everything but generated audio, which is optional. */
export const checksPass = (rows: CheckRow[]): boolean => rows.every((r) => r.state !== 'bad')
