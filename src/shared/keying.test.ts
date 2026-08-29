import { describe, expect, it } from 'vitest'
import { hasKey, judgeKey, keyColour, keyFilter, sameKey } from './keying'

describe('keyColour', () => {
	it('translates to ffmpeg’s own syntax', () => {
		expect(keyColour('#00B140')).toBe('0x00B140')
		expect(keyColour('1E90FF')).toBe('0x1E90FF')
	})

	it('falls back to the green screens are actually printed in', () => {
		expect(keyColour('nonsense')).toBe('0x00B140')
		expect(keyColour(undefined)).toBe('0x00B140')
	})
})

describe('keyFilter — chroma', () => {
	it('keys the colour it was given', () => {
		expect(keyFilter({ kind: 'chroma', colour: '#00FF00', similarity: 0.3, blend: 0.1, despill: 0 }))
			.toBe('chromakey=color=0x00FF00:similarity=0.3:blend=0.1')
	})

	it('pulls the spill, because that is what makes a key look real', () => {
		// Green bouncing off a shoulder survives the key and then sits on a
		// background it was never lit for.
		const chain = keyFilter({ kind: 'chroma', colour: '#00FF00', despill: 0.6 })
		expect(chain).toContain('despill=type=green:mix=0.6')
	})

	it('works out which spill to pull from the key colour', () => {
		expect(keyFilter({ kind: 'chroma', colour: '#0000FF' })).toContain('type=blue')
		// despill only knows green and blue, and a red screen would key skin.
		expect(keyFilter({ kind: 'chroma', colour: '#FF0000' })).not.toContain('despill')
	})

	it('clamps whatever it is handed', () => {
		const chain = keyFilter({ kind: 'chroma', similarity: 99, blend: -4, despill: 0 })
		expect(chain).toContain('similarity=1')
		expect(chain).toContain('blend=0')
	})
})

describe('keyFilter — luma', () => {
	it('keys the dark end by default', () => {
		expect(keyFilter({ kind: 'luma', threshold: 0.2, similarity: 0.1, blend: 0.05 }))
			.toBe('format=yuva420p,lumakey=threshold=0.2:tolerance=0.1:softness=0.05')
	})

	it('inverts to key the bright end, leaving the picture alone', () => {
		// `negate=alpha=0` flips the colours and not the alpha, so keying the
		// bright end is invert, key, invert back.
		const chain = keyFilter({ kind: 'luma', keepBright: false, threshold: 0.2 })
		expect(chain.match(/negate=alpha=0/g)).toHaveLength(2)
		expect(chain).toContain('lumakey')
	})
})

describe('hasKey and sameKey', () => {
	it('is nothing without a kind', () => {
		expect(hasKey(undefined)).toBe(false)
		expect(keyFilter(undefined)).toBe('')
	})

	it('compares by value, so undo sees a real edit', () => {
		expect(sameKey({ kind: 'chroma', similarity: 0.3 }, { kind: 'chroma', similarity: 0.3 })).toBe(true)
		expect(sameKey({ kind: 'chroma', similarity: 0.3 }, { kind: 'chroma', similarity: 0.4 })).toBe(false)
		expect(sameKey(undefined, undefined)).toBe(true)
		expect(sameKey(undefined, { kind: 'chroma' })).toBe(false)
	})
})

describe('judgeKey', () => {
	it('calls out a key that did almost nothing', () => {
		// The colour is wrong, or the tolerance is too tight — and saying so
		// beats a silent no-op, exactly as the transcript step reports health.
		expect(judgeKey(0.01).verdict).toBe('thin')
	})

	it('calls out a key eating the subject', () => {
		expect(judgeKey(0.97).verdict).toBe('heavy')
	})

	it('is happy in between, and says how much went', () => {
		const health = judgeKey(0.62)
		expect(health.verdict).toBe('good')
		expect(health.note).toContain('62%')
	})

	it('admits when it could not look', () => {
		expect(judgeKey(NaN).verdict).toBe('unknown')
	})
})
