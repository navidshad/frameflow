import { describe, expect, it } from 'vitest'
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { DEFAULT_AGENT_PERMISSIONS } from '@shared/agent'
import { FakeEditor } from '../../mcp/fakeEditor'
import { runLoopTurn, type LoopRunOptions } from './runLoopTurn'

/**
 * The loop against the real per-turn MCP server and an in-memory editor, with a
 * scripted model standing in for Gemini: what each test checks is the loop's
 * behaviour (steps, budget, abort, recovery), not a model's judgement.
 */

type Step = (call: { toolChoice?: any; prompt: any[] }) => any | Promise<any>

const usage = (input: number, output: number, reasoning = 0) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output - reasoning, reasoning }
})
const calls = (...items: { name: string; args?: object }[]): Step => () => ({
	content: items.map((c, i) => ({ type: 'tool-call', toolCallId: `c${Math.random().toString(36).slice(2, 8)}${i}`, toolName: c.name, input: JSON.stringify(c.args ?? {}) })),
	finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(100, 20, 10), warnings: []
})
const says = (text: string): Step => () => ({
	content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(120, 30, 5), warnings: []
})

/** Plays the steps in order; the last repeats if the loop asks for more. */
function scripted(steps: Step[]) {
	let i = 0
	const model = new MockLanguageModelV4({
		modelId: 'scripted',
		doGenerate: async (options: any) => steps[Math.min(i++, steps.length - 1)](options)
	})
	return model
}

const run = (model: any, extra: Partial<LoopRunOptions> = {}) => {
	const editor = new FakeEditor()
	const controller = new AbortController()
	const stepsSeen: number[] = []
	const options: LoopRunOptions = {
		engine: 'gemini-api', model, modelName: 'scripted', prompt: 'Tighten the cut', systemPrompt: 'SYS', history: [],
		maxSteps: 20, bridge: editor, turnId: 'turn-1', version: 'test', signal: controller.signal,
		permissions: () => ({ ...DEFAULT_AGENT_PERMISSIONS, edit: true }),
		onSteps: (steps) => stepsSeen.push(steps.length),
		...extra
	}
	return { editor, controller, stepsSeen, result: runLoopTurn(options) }
}

describe('runLoopTurn', () => {
	it('reads in parallel, edits, and answers; the steps and the answer come out as a CLI turn would', async () => {
		const model = scripted([
			calls({ name: 'get_project' }, { name: 'get_timeline' }),
			calls({ name: 'apply_ops', args: { rationale: 'Cut the pause', removeRanges: [{ fromSec: 10, toSec: 12.4 }] } }),
			says('I removed the pause at 10 to 12.4 seconds.')
		])
		const { editor, result, stepsSeen } = run(model)
		const r = await result
		expect(r.ok).toBe(true)
		expect(r.answer).toBe('I removed the pause at 10 to 12.4 seconds.')
		expect(r.steps.map((s) => [s.tool, s.status])).toEqual([['get_project', 'done'], ['get_timeline', 'done'], ['apply_ops', 'done']])
		expect(r.model).toBe('scripted')
		// The edit landed through apply_ops as a revision, linked to the chat turn.
		expect(r.commits).toHaveLength(1)
		expect(r.finalRevisionId).toBe(r.commits[0].revisionId)
		expect(editor.commits).toHaveLength(1)
		// The chat sees steps grow as they start.
		expect(Math.max(...stepsSeen)).toBe(3)
		// Thinking is billed apart from the answer; the totals add up across the three calls.
		expect(r.usage).toEqual({ promptTokens: 320, candidatesTokens: 45, thinkingTokens: 25, totalTokens: 390, cachedTokens: 0 })
	})

	it('hands back the whole conversation to save, and resumes from one', async () => {
		const first = await run(scripted([calls({ name: 'get_project' }), says('Read it.')])).result
		expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])

		const model = scripted([says('Shorter now.')])
		const second = await run(model, { history: first.messages, prompt: 'Make that shorter' }).result
		expect(second.ok).toBe(true)
		// The model was sent the earlier turn and then the new request.
		const sent = (model.doGenerateCalls[0].prompt as any[]).filter((m) => m.role !== 'system').map((m) => m.role)
		expect(sent).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
		expect(second.messages).toHaveLength(first.messages.length + 2)
	})

	it('turns tools off once the budget is spent, so the next model turn is the answer', async () => {
		const model = scripted([
			calls({ name: 'get_project' }),
			calls({ name: 'get_timeline' }),
			(call) => (call.toolChoice?.type === 'none' ? says('Out of calls: here is where I got to.')(call) : calls({ name: 'get_project' })(call))
		])
		const r = await run(model, { maxSteps: 2 }).result
		expect(r.ok).toBe(true)
		expect(r.answer).toBe('Out of calls: here is where I got to.')
		expect(model.doGenerateCalls[2].toolChoice).toEqual({ type: 'none' })
		expect(r.steps).toHaveLength(2)
	})

	it('stops a model that ignores the budget', async () => {
		const model = scripted([calls({ name: 'get_project' })])
		const r = await run(model, { maxSteps: 1 }).result
		expect(r.ok).toBe(false)
	})

	it('stops at once when aborted, and leaves the conversation as it was', async () => {
		const history = [{ role: 'user', content: 'earlier' }] as any
		const hang: Step = (call: any) => new Promise((_, reject) => call.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))))
		const { controller, result } = run(scripted([hang]), { history })
		setTimeout(() => controller.abort(), 50)
		const r = await result
		expect(r.cancelled).toBe(true)
		expect(r.ok).toBe(false)
		expect(r.messages).toEqual(history)
	})

	it('carries on after a tool fails, and marks that step as failed', async () => {
		const model = scripted([
			calls({ name: 'apply_ops', args: { removeClips: ['i1'] } }),
			calls({ name: 'apply_ops', args: { rationale: 'Cut it', removeRanges: [{ fromSec: 1, toSec: 2 }] } }),
			says('Done after fixing my call.')
		])
		const r = await run(model).result
		expect(r.ok).toBe(true)
		expect(r.steps.map((s) => s.status)).toEqual(['error', 'done'])
		expect(r.steps[0].error).toMatch(/unknown field/)
		expect(r.commits).toHaveLength(1)
	})

	it('survives a tool call the model got wrong in the arguments', async () => {
		const model = scripted([calls({ name: 'get_project', args: { nonsense: [1, 2, 3] } }), calls({ name: 'no_such_tool' }), says('Recovered.')])
		const r = await run(model).result
		expect(r.ok).toBe(true)
		expect(r.answer).toBe('Recovered.')
	})

	it('keeps its plan out of the budget and titles the step with where it is', async () => {
		const plan = (statuses: string[]) => calls({ name: 'update_plan', args: { items: statuses.map((s, i) => ({ step: `Step ${i + 1}`, status: s })) } })
		// With a budget of one call, two plan updates still leave that call free.
		const model = scripted([plan(['in_progress', 'pending']), plan(['completed', 'in_progress']), calls({ name: 'get_project' }), says('Done.')])
		const r = await run(model, { maxSteps: 1 }).result
		expect(r.ok).toBe(true)
		expect(r.steps.map((s) => s.title)).toEqual(['plan · 0/2 · Step 1', 'plan · 1/2 · Step 2', 'get_project'])
	})

	it('says what went wrong in words: a rejected key is something to fix', async () => {
		const failing = new MockLanguageModelV4({
			modelId: 'scripted',
			doGenerate: async () => { throw new APICallError({ message: 'API key not valid', url: 'https://x', requestBodyValues: {}, statusCode: 403, responseBody: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' }) }
		})
		const r = await run(failing).result
		expect(r.ok).toBe(false)
		expect(r.note).toMatch(/rejected the API key/)
		expect(r.error).toMatch(/Gemini API/)
	})

	it('names the model when it does not exist', async () => {
		const missing = new MockLanguageModelV4({
			modelId: 'scripted',
			doGenerate: async () => { throw new APICallError({ message: 'not found', url: 'https://x', requestBodyValues: {}, statusCode: 404, responseBody: '{"error":{"message":"models/old is not found"}}' }) }
		})
		const r = await run(missing, { modelName: 'old' }).result
		expect(r.error).toMatch(/no model called old/)
		expect(r.note).toBeUndefined()
	})

	it('offers the model FrameFlow\u2019s tools and its plan, but not the round tools that are for outside agents', async () => {
		const model = scripted([says('Hi.')])
		await run(model).result
		const offered = (model.doGenerateCalls[0].tools as any[]).map((t) => t.name)
		expect(offered).toContain('get_timeline')
		expect(offered).toContain('apply_ops')
		expect(offered).toContain('update_plan')
		expect(offered).not.toContain('begin_round')
		expect(offered).not.toContain('end_round')
	})

	it('does not let the model export: the server refuses', async () => {
		const model = scripted([calls({ name: 'export' }), says('Could not export.')])
		const { editor, result } = run(model)
		const r = await result
		expect(r.steps[0].status).toBe('error')
		expect(editor.exports).toBe(0)
	})

	describe('the review after an edit', () => {
		const cut = calls({ name: 'apply_ops', args: { rationale: 'Cut the pause', removeRanges: [{ fromSec: 10, toSec: 12.4 }] } })
		const lastPrompt = (model: any, call: number) => {
			const messages = model.doGenerateCalls[call].prompt as any[]
			const last = messages[messages.length - 1]
			return (Array.isArray(last.content) ? last.content.map((p: any) => p.text ?? '').join('') : String(last.content))
		}

		it('does not take "done" after an edit: it measures, sends the checklist, and the answer comes after', async () => {
			const model = scripted([cut, says('Cut the pause.'), calls({ name: 'render_frames', args: { times: [9.8, 10.2] } }), says('Removed 2.4 s at 0:10; checked the join.')])
			const r = await run(model, { reviews: 2, request: 'Tighten it' }).result
			expect(r.ok).toBe(true)
			// The model was handed what FrameFlow measured: 30 s to 27.6 s, and the new join at 0:10.
			const review = lastPrompt(model, 2)
			expect(review).toMatch(/\[FrameFlow review\]/)
			expect(review).toContain('0:30.0 before this turn, 0:27.6 now (−2.4 s)')
			expect(review).toContain('0:10.0')
			expect(review).toContain('"Tighten it"')
			expect(review).toContain('You have not looked at a frame since your last edit.')
			expect(r.answer).toBe('Removed 2.4 s at 0:10; checked the join.')
			expect(r.steps.map((s) => s.tool)).toEqual(['apply_ops', 'review', 'render_frames'])
			expect(r.steps[1].title).toBe('review · measured, checklist')
			expect(r.notes).toBeUndefined()
			// The review is part of the conversation the next turn resumes from.
			expect(JSON.stringify(r.messages)).toContain('[FrameFlow review]')
		})

		it('asks once more when the agent still has not looked, then says so on the card', async () => {
			const model = scripted([cut, says('Done.')])
			const r = await run(model, { reviews: 2 }).result
			expect(r.ok).toBe(true)
			expect(r.steps.map((s) => s.tool)).toEqual(['apply_ops', 'review', 'review'])
			expect(r.steps[2].title).toBe('review again · measured, checklist')
			expect(r.notes).toEqual(['It did not look at a frame after its last edit.'])
		})

		it('stops after one review when the agent looked and changed nothing more', async () => {
			const model = scripted([cut, calls({ name: 'render_frame', args: { timeSec: 10 } }), says('Done.'), says('Checked, all good.')])
			const r = await run(model, { reviews: 2 }).result
			expect(r.steps.filter((s) => s.tool === 'review')).toHaveLength(1)
			expect(r.answer).toBe('Checked, all good.')
		})

		it('is not held for a question, which edits nothing', async () => {
			const model = scripted([calls({ name: 'get_project' }), says('It is 30 seconds long.')])
			const r = await run(model, { reviews: 2 }).result
			expect(r.steps.map((s) => s.tool)).toEqual(['get_project'])
		})

		it('cannot review with no calls left, and says so', async () => {
			const model = scripted([cut, says('Done.')])
			const r = await run(model, { reviews: 2, maxSteps: 1 }).result
			expect(r.steps.map((s) => s.tool)).toEqual(['apply_ops'])
			expect(r.notes).toEqual(['No tool calls were left to check the result.', 'It did not look at a frame after its last edit.'])
		})
	})
})

