import { describe, expect, it } from 'vitest'
import { docsFor, splitSections } from './providerDocs'

/**
 * Laid out like ElevenLabs' models page (markdown, read 2026-11-24): flagship
 * summaries by kind, an overview table of every model, the deprecated ones,
 * a selection guide, then a section per model. The words are made up here.
 */
const PAGE = `# Models

## Flagship models

### Text to Speech

#### [Voice Four](/docs/overview/models#voice-four)
Newest speech model.

#### [Steady Two](/docs/overview/models#steady-two)
Stable over long scripts.

### Speech to Text

#### [Listener Three](/docs/overview/models#listener-three)
Transcribes recordings.

### Music

#### [Tunes Two](/docs/overview/models#tunes-two)
Songs and beds.

## Models overview

| Model ID | Description |
| -------- | ----------- |
| \`voice_v4\` | Newest speech |
| \`steady_v2\` | Stable speech |
| \`listen_v3\` | Transcription |
| \`tunes_v2\` | Music |
| \`sfx_v3\` | Sound effects |

### Deprecated models

\`tunes_v1\` is removed on January 31, 2027.

## Model selection guide

Pick for quality or for speed.

## Voice Four

Reads 100,000 characters a request.

## Listener Three

Word timestamps and speakers.

## SFX v3

\`sfx_v3\` loops smoothly.
`

describe('splitting the page', () => {
	it('cuts at every heading and keeps the path of headings above it, without link markup', () => {
		const headings = splitSections(PAGE).map((s) => s.heading)
		expect(headings).toContain('Models › Flagship models › Text to Speech › Voice Four')
		expect(headings).toContain('Models › Models overview › Deprecated models')
		expect(headings).toContain('Models › SFX v3')
	})
})

describe('the parts about one kind', () => {
	it('keeps sections naming today’s models or the kind, and the guide, and leaves the rest out', () => {
		const speech = docsFor(PAGE, 'speech', ['voice_v4', 'steady_v2'], undefined, ['Voice Four', 'Steady Two'])
		expect(speech).toContain('Newest speech model.')
		expect(speech).toContain('Reads 100,000 characters a request.')
		expect(speech).toContain('Pick for quality or for speed.')
		expect(speech).toContain('removed on January 31, 2027')
		expect(speech).not.toContain('Word timestamps')
		expect(speech).not.toContain('Songs and beds')
	})

	it('keeps only its own rows of a table that lists every model', () => {
		const music = docsFor(PAGE, 'music', ['tunes_v1', 'tunes_v2'])
		expect(music).toContain('| `tunes_v2` | Music |')
		expect(music).not.toContain('voice_v4')
		expect(music).toContain('| Model ID | Description |')
	})

	it('finds a model the page adds tomorrow, by the id the provider lists', () => {
		const tomorrow = `${PAGE}\n## Voice Five\n\n\`voice_v5\` is here.\n`
		expect(docsFor(tomorrow, 'speech', ['voice_v5'])).toContain('`voice_v5` is here.')
	})

	it('stays within its budget', () => {
		const huge = `${PAGE}\n## Voice Four details\n\n${'voice_v4 '.repeat(5000)}`
		expect(docsFor(huge, 'speech', ['voice_v4'], 2000).length).toBeLessThanOrEqual(2000)
	})
})
