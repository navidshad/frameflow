import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { EditorHistoryFile, EditorHistoryStep, TimelineSnapshot } from '@shared/types'
import { HistoryStore, MAX_STEPS } from './historyStore'

const THREAD = 'thread-h'
let root: string
let seq: number

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-'))
	seq = 0
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const store = () => new HistoryStore(root, async () => ++seq)
const file = () => path.join(root, `${THREAD}.json`)
const page = (variant: string) => `<!doctype html>${variant}` + `<p>${variant}</p>`.repeat(3000)

const step = (id: string, from: string, to: string): EditorHistoryStep => ({
	id, seq: 0, origin: 'manual', label: id, createdAt: 1,
	forward: { updated: [{ id: 'item', patch: { motion: { html: page(to) } } }] } as any,
	inverse: { updated: [{ id: 'item', patch: { motion: { html: page(from) } } }] } as any
})

const keyframe = (variant: string): TimelineSnapshot => ({
	stepId: '', tracks: [], timelineMeta: { duration: 1 } as any,
	timeline: Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, motion: { html: page(i === 0 ? variant : `fixed${i}`) } })) as any
})

describe('HistoryStore', () => {
	it('round-trips steps and stores repeated page text once', async () => {
		const s = store()
		const steps: EditorHistoryStep[] = []
		for (let i = 1; i <= 30; i++) {
			const st = step(`s${i}`, `v${i - 1}`, `v${i}`)
			const res = await s.pushStep(THREAD, st, i % 10 === 0 ? keyframe(`v${i}`) : undefined)
			steps.push({ ...st, seq: res.seq })
		}
		const loaded = await store().load(THREAD)
		expect(loaded.problem).toBeUndefined()
		expect(loaded.currentStepId).toBe('s30')
		expect(loaded).not.toHaveProperty('keyframes')
		expect(loaded.steps).toEqual(steps)

		// 31 distinct page versions + 9 fixed keyframe pages; each step names two versions.
		const pageSize = page('v10').length
		expect(fs.statSync(file()).size).toBeLessThan(45 * pageSize)
		expect(fs.readFileSync(file(), 'utf8').startsWith('{"schemaVersion":2')).toBe(true)
	})

	it('drops the redo branch and the text only it used', async () => {
		const s = store()
		await s.pushStep(THREAD, step('a', 'v0', 'v1'))
		await s.pushStep(THREAD, step('b', 'v1', 'only-in-b'))
		await s.setPointer(THREAD, 'a')
		await s.pushStep(THREAD, step('c', 'v1', 'v3'))
		const loaded = await s.load(THREAD)
		expect(loaded.steps.map((x) => x.id)).toEqual(['a', 'c'])
		expect(fs.readFileSync(file(), 'utf8')).not.toContain('only-in-b')
	})

	it('caps the ring and reports evicted ids', async () => {
		const s = store()
		const pruned: string[] = []
		for (let i = 1; i <= MAX_STEPS + 3; i++) pruned.push(...(await s.pushStep(THREAD, step(`s${i}`, `${i - 1}`, `${i}`))).prunedIds)
		expect(pruned).toEqual(['s1', 's2', 's3'])
		expect((await s.load(THREAD)).steps).toHaveLength(MAX_STEPS)
	})

	it('migrates a schema 1 file and keeps every step', async () => {
		const steps = Array.from({ length: 12 }, (_, i) => ({ ...step(`s${i}`, `v${i}`, `v${i + 1}`), seq: i + 1 }))
		const keyframes = [{ ...keyframe('v10'), stepId: 's9' }]
		const legacy: EditorHistoryFile = { threadId: THREAD, steps, keyframes, currentStepId: 's7' }
		fs.writeFileSync(file(), JSON.stringify(legacy))
		const before = fs.statSync(file()).size

		const loaded = await store().load(THREAD)
		expect(loaded.problem).toBeUndefined()
		expect(loaded.steps).toEqual(steps)
		expect(loaded.currentStepId).toBe('s7')
		// Schema 1 held each step's pages twice plus the keyframe's; schema 2 holds the distinct text once.
		const distinct = new Set([...steps.flatMap((x) => [x.forward, x.inverse]), keyframes[0].timeline]
			.flatMap((v) => JSON.stringify(v).match(/<!doctype html>[a-z0-9]+/g) || []))
		const distinctChars = [...distinct].reduce((sum, head) => sum + page(head.slice(15)).length, 0)
		expect(distinct.size).toBe(22)
		expect(before).toBeGreaterThan(1.4 * distinctChars)
		expect(fs.statSync(file()).size).toBeLessThan(distinctChars + 20_000)

		// The converted file keeps working: a push after s7 truncates s8..s11.
		await store().pushStep(THREAD, step('n', 'v8', 'v99'))
		expect((await store().load(THREAD)).steps.map((x) => x.id)).toEqual([...steps.slice(0, 8).map((x) => x.id), 'n'])
	})

	it('sets an unreadable history aside and opens empty', async () => {
		fs.writeFileSync(file(), '{"threadId":"x","steps":[{"id":"a"},{"id":')
		const loaded = await store().load(THREAD)
		expect(loaded.steps).toEqual([])
		expect(loaded.currentStepId).toBe('')
		expect(loaded.problem).toMatch(/could not be read/)
		expect(fs.readdirSync(root).some((n) => n.startsWith(`${THREAD}.json.unreadable-`))).toBe(true)
		expect((await store().pushStep(THREAD, step('a', '0', '1'))).stepCount).toBe(1)
	})
})
