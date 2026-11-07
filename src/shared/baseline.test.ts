import { describe, expect, it } from 'vitest'
import { FRAMEFLOW_BASELINE, FRAMEFLOW_OVERVIEW, FRAMEFLOW_TOOLS, outsideAgentInstructions, ROUND_PROTOCOL } from './baseline'
import { TOOLS } from '../main/mcp/tools'

describe('the agent baseline', () => {
	it('describes the system and gives no opinion about the edit', () => {
		// Presets biased the internal agent and lowered its edits: what to make, how
		// long, in what style, is the user's request and nothing else.
		for (const text of [FRAMEFLOW_OVERVIEW, FRAMEFLOW_TOOLS]) {
			expect(text).not.toMatch(/persona|by default|prefer|house style|pacing|tone\b|tighten|tight\b/i)
		}
	})

	it('names what each thing in a project is', () => {
		for (const word of ['Media', 'Timeline', 'Motion layers', 'Sound', 'Cameras', 'Revisions']) {
			expect(FRAMEFLOW_OVERVIEW).toContain(word)
		}
	})

	it('only names tools that exist', () => {
		const names = new Set(TOOLS.map((t) => t.name))
		const mentioned = FRAMEFLOW_TOOLS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
		expect(mentioned.length).toBeGreaterThan(10)
		for (const name of mentioned) expect(names.has(name), name).toBe(true)
	})

	it('names only ops apply_ops accepts', () => {
		const schema = JSON.stringify(TOOLS.find((t) => t.name === 'apply_ops')!.inputSchema)
		for (const op of ['addSounds', 'placeAudio', 'setSpeaker', 'switchAngles']) {
			expect(FRAMEFLOW_TOOLS).toContain(op)
			expect(schema, op).toContain(`"${op}"`)
		}
	})

	it('outside agents get the baseline plus the round protocol; the engine does not', () => {
		const outside = outsideAgentInstructions()
		expect(outside).toContain(FRAMEFLOW_OVERVIEW)
		expect(outside).toContain(FRAMEFLOW_TOOLS)
		expect(outside).toContain(ROUND_PROTOCOL)
		expect(outside).toMatch(/begin_round/)
		expect(FRAMEFLOW_BASELINE).not.toMatch(/begin_round|end_round/)
	})
})
