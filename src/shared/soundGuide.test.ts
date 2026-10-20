import { describe, expect, it } from 'vitest'
import { SOUND_PRESETS } from './synth'
import { soundGuideText } from './soundGuide'

describe('the sound guide', () => {
	const text = soundGuideText()

	it('lists every sound in the palette by name, so it cannot drift from the palette', () => {
		for (const p of SOUND_PRESETS) expect(text, p.kind).toContain(`- ${p.kind}:`)
	})

	it('gives the numbers, not adjectives: lengths, levels and the target gaps', () => {
		expect(text).toMatch(/whoosh: .* 0\.50 s, peak -17 dB/)
		expect(text).toContain('About 12 LU under the voice')
		expect(text).toContain('−1 dBTP')
		expect(text).toContain('-14 LUFS')
	})

	it('names the tools an agent should use, in order', () => {
		for (const tool of ['suggest_cues', 'apply_ops', 'addSounds', 'follow', 'render_sound', 'analyze_audio', 'revert_to_version']) {
			expect(text, tool).toContain(tool)
		}
		expect(text.indexOf('suggest_cues')).toBeLessThan(text.indexOf('apply_ops with addSounds'))
	})

	it('says the one thing about key that an agent would otherwise get wrong', () => {
		expect(text).toMatch(/SAME pitch/)
	})
})
