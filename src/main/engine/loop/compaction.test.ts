import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { compactMessages, DEFAULT_COMPACT, resultSize, STORAGE_COMPACT, trimHistory } from './compaction'

const big = 'x'.repeat(5000)
const text = (value: string) => ({ type: 'content', value: [{ type: 'text', text: value }] })
const withPicture = (caption = 'frame') => ({
	type: 'content',
	value: [{ type: 'text', text: caption }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } }]
})
const result = (id: string, tool: string, output: any): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: tool, output }] }) as ModelMessage
const call = (id: string, tool: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: tool, input: {} }] }) as ModelMessage
const outputOf = (m: ModelMessage) => (m.content as any[])[0].output

describe('compactMessages', () => {
	it('leaves a short conversation alone, as the same array', () => {
		const messages = [{ role: 'user', content: 'hi' }, call('a', 'get_project'), result('a', 'get_project', text(big))] as ModelMessage[]
		expect(compactMessages(messages)).toBe(messages)
	})

	it('clears old big results to a stub that names the tool, and keeps the newest in full', () => {
		const messages: ModelMessage[] = [{ role: 'user', content: 'go' }]
		for (let i = 0; i < 12; i++) messages.push(call(`c${i}`, 'get_timeline'), result(`c${i}`, 'get_timeline', text(big)))
		const out = compactMessages(messages, DEFAULT_COMPACT)
		const results = out.filter((m) => m.role === 'tool')
		expect(results).toHaveLength(12)
		// The newest 5 are whole, the 7 before are stubs.
		expect(results.slice(7).every((m) => resultSize(outputOf(m)) === 5000)).toBe(true)
		expect(results.slice(0, 7).every((m) => outputOf(m).type === 'text')).toBe(true)
		expect(outputOf(results[0])).toMatchObject({ type: 'text' })
		expect(outputOf(results[0]).value).toMatch(/get_timeline.*cleared.*Call get_timeline again/)
		// Calls and the pairing stay: every result still has its call.
		expect(out.filter((m) => m.role === 'assistant')).toHaveLength(12)
		// Nothing was mutated.
		expect(resultSize(outputOf(messages.filter((m) => m.role === 'tool')[0]))).toBe(5000)
	})

	it('keeps small old results: they cost little and say what happened', () => {
		const messages: ModelMessage[] = [{ role: 'user', content: 'go' }]
		for (let i = 0; i < 12; i++) messages.push(call(`c${i}`, 'apply_ops'), result(`c${i}`, 'apply_ops', text('{"revision":"V2"}')))
		expect(compactMessages(messages)).toBe(messages)
	})

	it('keeps only the newest pictures, but their captions stay', () => {
		const messages: ModelMessage[] = [{ role: 'user', content: 'go' }]
		for (let i = 0; i < 4; i++) messages.push(call(`f${i}`, 'render_frame'), result(`f${i}`, 'render_frame', withPicture(`frame ${i}`)))
		const out = compactMessages(messages, { keepResults: 8, keepImages: 2, stubOver: 1000 })
		const outputs = out.filter((m) => m.role === 'tool').map(outputOf)
		const hasPicture = (o: any) => o.value.some((p: any) => p.type === 'file')
		expect(outputs.map(hasPicture)).toEqual([false, false, true, true])
		expect(outputs[0].value[0].text).toBe('frame 0')
	})

	it('an older result with a picture is cleared whole, even a short one', () => {
		const messages: ModelMessage[] = [{ role: 'user', content: 'go' }, call('p', 'render_frame'), result('p', 'render_frame', withPicture())]
		for (let i = 0; i < DEFAULT_COMPACT.keepResults; i++) messages.push(call(`c${i}`, 'get_project'), result(`c${i}`, 'get_project', text('ok')))
		const first = outputOf(compactMessages(messages).filter((m) => m.role === 'tool')[0])
		expect(first.type).toBe('text')
		expect(first.value).toMatch(/render_frame.*picture/)
	})

	it('stores no pictures at all', () => {
		const messages = [{ role: 'user', content: 'go' }, call('f', 'render_frame'), result('f', 'render_frame', withPicture())] as ModelMessage[]
		const out = compactMessages(messages, STORAGE_COMPACT).filter((m) => m.role === 'tool').map(outputOf)
		expect(out[0].value.some((p: any) => p.type === 'file')).toBe(false)
	})

	it('measures what the model reads, not a picture\'s bytes', () => {
		expect(resultSize(withPicture('abc'))).toBe(3)
		expect(resultSize({ type: 'json', value: { a: 1 } })).toBe(7)
		expect(resultSize({ type: 'text', value: 'hello' })).toBe(5)
	})
})

describe('trimHistory', () => {
	const turn = (n: number): ModelMessage[] => [
		{ role: 'user', content: `request ${n} ${'.'.repeat(500)}` }, call(`t${n}`, 'get_project'), result(`t${n}`, 'get_project', text('ok')),
		{ role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] } as ModelMessage
	]

	it('leaves a history that fits', () => {
		const messages = [...turn(1), ...turn(2)]
		expect(trimHistory(messages, 100_000)).toBe(messages)
	})

	it('drops the oldest turns whole and starts at a request, never at a result', () => {
		const messages = [...turn(1), ...turn(2), ...turn(3)]
		const size = JSON.stringify(turn(3)).length + 200
		const out = trimHistory(messages, size)
		expect(out[0].role).toBe('user')
		expect(JSON.stringify(out[0])).toContain('request 3')
		expect(out).toHaveLength(4)
	})

	it('always keeps the newest message', () => {
		const messages = [...turn(1)]
		expect(trimHistory(messages, 10).length).toBeGreaterThan(0)
	})
})
