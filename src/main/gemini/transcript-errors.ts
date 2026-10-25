/**
 * Turn a failed transcription into a reason a person can act on. The raw
 * errors ("404 … models/gemini-2.5-flash-lite is no longer available to new
 * users") were only logged, so the media just looked untranscribed.
 */
export function explainTranscriptError(message: string, model?: string): string {
	const text = String(message || '').trim()
	const lower = text.toLowerCase()
	const name = model ? `“${model}”` : 'The transcript model'

	if (lower.includes('no longer available') || (/\b404\b/.test(lower) && lower.includes('model')) || lower.includes('not found for api version')) {
		return `${name} is not available to this API key (Google retired it for new keys). ` +
			'Pick another model for Transcript in Settings → Models, then transcribe again.'
	}
	if (lower.includes('api key not found') || lower.includes('api key not valid') || lower.includes('api_key_invalid')) {
		return 'No working Gemini API key. Add one in Settings, then transcribe again.'
	}
	if (lower.includes('quota') || lower.includes('resource_exhausted') || /\b429\b/.test(lower)) {
		return `${name} is over its quota for this API key. Wait and retry, or pick another model in Settings → Models.`
	}
	if (lower.includes('permission') || /\b403\b/.test(lower)) {
		return `This API key may not use ${name.replace(/^The/, 'the')}. Pick another model in Settings → Models.`
	}
	return text ? `Transcription failed: ${text}` : 'Transcription failed.'
}
