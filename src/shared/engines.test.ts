import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	agentFocus, buildCommand, ENGINES, CLI_EFFORTS, engineEfforts, STEPS_DEFAULT, STEPS_MAX, buildEngineSystemPrompt, buildEngineUserPrompt, displayPath, editTime,
	engineChipLabel, engineChipShort, engineFailureNote, geminiTextModels, engineRetry, isCliEngine, isLoopEngine, latestEngineTurn, resumableSessionId, shouldRestartFresh, isFrameflowTool, lineSplitter, normalizeEngineSettings, normalizeToolName, parseClaudeAuth,
	parseStreamLine, parseVersion, readableError, StepTracker, stepTitle, TOKEN_ENV, unexpectedTools, type CliEngineId
} from './engines'
import { FRAMEFLOW_BASELINE } from './baseline'
import type { PromptTurn } from './types'

const fixture = (name: string) => readFileSync(resolve(__dirname, '../main/engine/fixtures', name), 'utf-8')

const track = (id: CliEngineId, text: string) => {
	const tracker = new StepTracker()
	for (const line of text.split('\n')) for (const event of parseStreamLine(id, line)) tracker.apply(event)
	return tracker
}

describe('recorded streams', () => {
	it('Claude Code: init tools, three FrameFlow steps, the final answer', () => {
		const t = track('claude-code', fixture('claude.stream.jsonl'))
		expect(t.initTools?.every((name) => name.startsWith('mcp__frameflow__'))).toBe(true)
		expect(unexpectedTools(t.initTools)).toEqual([])
		expect(t.steps.map((s) => [s.title, s.status])).toEqual([
			['get_project', 'done'],
			['search_moments “faster”', 'done'],
			['apply_ops addMarkers @ 0:24.0', 'done']
		])
		expect(t.done).toEqual({ ok: true, error: undefined })
		expect(t.answer).toMatch(/FrameFlow ones/)
		expect(t.foreignTools).toEqual([])
	})
})

describe('parsing edge cases', () => {
	it('ignores banners and broken JSON', () => {
		expect(parseStreamLine('claude-code', 'Warning: 256-color support not detected.')).toEqual([])
		expect(parseStreamLine('claude-code', '{"type": "assistant", ')).toEqual([])
	})

	it('splits lines across chunks', () => {
		const lines: string[] = []
		const split = lineSplitter((l) => lines.push(l))
		split.push('{"a":1}\n{"b"')
		split.push(':2}\n{"c":3}')
		split.end()
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
	})

	it('a killed run settles running steps as stopped', () => {
		const t = new StepTracker()
		t.apply({ type: 'tool-start', callId: 'x', tool: 'get_project', server: 'frameflow', args: {} })
		t.settle()
		expect(t.steps[0]).toMatchObject({ status: 'error', error: 'Stopped' })
	})

	it('a step outside FrameFlow is flagged as foreign', () => {
		const t = new StepTracker()
		t.apply({ type: 'tool-start', callId: 'y', tool: 'Bash', server: null, args: { command: 'ls' } })
		expect(t.foreignTools).toEqual(['Bash'])
		expect(t.steps[0].title).toBe('Bash — not allowed')
	})

	it('normalises Claude Code’s tool names', () => {
		expect(normalizeToolName('mcp__frameflow__get_media')).toEqual({ server: 'frameflow', tool: 'get_media' })
		expect(normalizeToolName('get_project', 'frameflow')).toEqual({ server: 'frameflow', tool: 'get_project' })
		expect(normalizeToolName('Bash')).toEqual({ server: null, tool: 'Bash' })
		expect(unexpectedTools(['mcp__frameflow__get_project', 'Bash', 'mcp__other__x'])).toEqual(['Bash', 'mcp__other__x'])
	})
})

describe('step titles and focus', () => {
	it('titles read like the design', () => {
		expect(stepTitle('search_moments', { query: 'introduces herself' })).toBe('search_moments “introduces herself”')
		expect(stepTitle('get_media', { asset: 'greeting_team.mp4', fromSec: 2, toSec: 9 })).toBe('get_media greeting_team 0:02.0–0:09.0')
		expect(stepTitle('render_frame', { timeSec: 4.2 })).toBe('render_frame 0:04.2')
		expect(stepTitle('revert_to_version', { version: 6 })).toBe('revert_to_version V6')
		expect(stepTitle('apply_ops', { rationale: 'x', addMotion: [{ timelineStart: 3 }], removeRanges: [{ start: 9, end: 10 }, { start: 12, end: 13 }] }))
			.toBe('apply_ops addMotion · removeRanges ×2 @ 0:03.0')
	})

	it('edit time reads timeline positions, not source in/out', () => {
		expect(editTime({ updateItems: [{ id: 'a', in: 1, timelineStart: 7 }], addMarkers: [{ atSec: 5 }] })).toBe(5)
		expect(editTime({ updateItems: [{ id: 'a', in: 1 }] })).toBeUndefined()
	})

	it('focus: reading media, looking at a frame, editing at a time', () => {
		expect(agentFocus('get_media', { asset: 'team' })).toEqual({ kind: 'read', asset: 'team' })
		expect(agentFocus('render_frame', { timeSec: 27.5 })).toEqual({ kind: 'look', timeSec: 27.5 })
		expect(agentFocus('apply_ops', { addMarkers: [{ atSec: 24 }] })).toEqual({ kind: 'edit', timeSec: 24 })
		expect(agentFocus('get_project', {})).toBeNull()
	})
})

describe('detection parsing', () => {
	it('version from --version', () => {
		expect(parseVersion('2.1.231 (Claude Code)\n')).toBe('2.1.231')
		expect(parseVersion('nope')).toBeUndefined()
	})

	it('sign-in state where the CLI reports it', () => {
		expect(parseClaudeAuth('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true)
		expect(parseClaudeAuth('{"loggedIn": false}')).toBe(false)
		expect(parseClaudeAuth('garbage')).toBeNull()
	})

	it('paths under home are shortened', () => {
		expect(displayPath('/Users/me/.local/bin/claude', '/Users/me')).toBe('~/.local/bin/claude')
		expect(displayPath('/opt/homebrew/bin/claude', '/Users/me')).toBe('/opt/homebrew/bin/claude')
		expect(displayPath('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
	})

	it('recognises a sign-in the user has to fix', () => {
		expect(engineFailureNote('claude-code', 'Not logged in · Please run /login')).toMatch(/not signed in/)
		expect(engineFailureNote('claude-code', 'some other failure')).toBeNull()
	})
})

describe('errors', () => {
	it('pulls the message out of a raw API error', () => {
		const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported with this account."}}'
		expect(readableError(raw)).toBe("The 'x' model is not supported with this account.")
		expect(readableError('Plain failure')).toBe('Plain failure')
	})
})

describe('settings', () => {
	it('clamps and fills', () => {
		expect(normalizeEngineSettings(undefined)).toEqual({
			engine: 'gemini-api', models: { 'claude-code': 'claude-opus-5-5' }, efforts: { 'claude-code': 'medium' }, maxSteps: STEPS_DEFAULT
		})
		expect(normalizeEngineSettings({ engine: 'claude-code', maxSteps: 9000, models: { 'claude-code': ' opus ' } }))
			.toEqual({ engine: 'claude-code', models: { 'claude-code': 'claude-opus-5-5' }, efforts: { 'claude-code': 'medium' }, maxSteps: STEPS_MAX })
		// A model id the list does not know is kept as typed.
		expect(normalizeEngineSettings({ engine: 'claude-code', models: { 'claude-code': 'claude-opus-4-1' } }).models)
			.toEqual({ 'claude-code': 'claude-opus-4-1' })
		// Nothing chosen is the default model, never "no model".
		expect(normalizeEngineSettings({ engine: 'claude-code', models: { 'claude-code': '' } }).models).toEqual({ 'claude-code': 'claude-opus-5-5' })
		expect(normalizeEngineSettings({ engine: 'nope' as any }).engine).toBe('gemini-api')
	})

	it('keeps an effort the CLI lists and replaces one it does not with the default', () => {
		expect(normalizeEngineSettings({ engine: 'claude-code', efforts: { 'claude-code': ' xhigh ' } }).efforts).toEqual({ 'claude-code': 'xhigh' })
		expect(normalizeEngineSettings({ engine: 'claude-code', efforts: { 'claude-code': 'ludicrous' } }).efforts).toEqual({ 'claude-code': 'medium' })
		expect(normalizeEngineSettings({ engine: 'claude-code', efforts: { 'claude-code': '' } }).efforts).toEqual({ 'claude-code': 'medium' })
	})

	it('reads the old default of 20 steps as never changed', () => {
		// Settings files saved the old default as if the user had chosen it.
		expect(normalizeEngineSettings({ maxSteps: 20 }).maxSteps).toBe(STEPS_DEFAULT)
		expect(normalizeEngineSettings({ maxSteps: 21 }).maxSteps).toBe(21)
		expect(STEPS_DEFAULT).toBeGreaterThan(20)
	})

	it('effort choices belong to the engine: Claude Code has them, Gemini API does not', () => {
		expect(engineEfforts('claude-code')).toEqual(CLI_EFFORTS['claude-code'])
		expect(engineEfforts('claude-code').map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
		expect(engineEfforts('gemini-api')).toEqual([])
	})
})

describe('command lines', () => {
	const base = { prompt: 'Cut the pauses', systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:5555/mcp', workDir: '/tmp/run' }

	it('Claude Code: FrameFlow server only, no built-in tools, token by env', () => {
		const spec = buildCommand({ ...base, engine: 'claude-code', model: 'opus' })
		const a = spec.args
		expect(a.slice(0, 2)).toEqual(['-p', 'Cut the pauses'])
		expect(a[a.indexOf('--tools') + 1]).toBe('')
		expect(a).toContain('--strict-mcp-config')
		expect(a[a.indexOf('--mcp-config') + 1]).toBe('/tmp/run/mcp.json')
		expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__frameflow')
		expect(a[a.indexOf('--system-prompt') + 1]).toBe('SYS')
		expect(a.slice(-2)).toEqual(['--model', 'opus'])
		expect(a).not.toContain('--effort')
		const config = JSON.parse(spec.files[0].content)
		expect(config.mcpServers.frameflow).toEqual({ type: 'http', url: base.mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } })
		expect(JSON.stringify(spec)).not.toMatch(/ff_/)
	})

	it('Claude Code: passes --effort only when one is chosen', () => {
		const a = buildCommand({ ...base, engine: 'claude-code', model: 'opus', effort: 'high' }).args
		expect(a[a.indexOf('--effort') + 1]).toBe('high')
		expect(a[a.indexOf('--model') + 1]).toBe('opus')
		expect(buildCommand({ ...base, engine: 'claude-code', effort: '  ' }).args).not.toContain('--effort')
	})

	it('Claude Code: a message with pictures goes in on stdin as one stream-json user message', () => {
		const spec = buildCommand({ ...base, engine: 'claude-code', images: [{ data: 'AAAA', mimeType: 'image/jpeg' }, { data: 'BBBB', mimeType: 'image/png' }] })
		expect(spec.args.slice(0, 3)).toEqual(['-p', '--input-format', 'stream-json'])
		// The prompt is not an argument too: it would be read as a second message.
		expect(spec.args).not.toContain('Cut the pauses')
		expect(spec.args[spec.args.indexOf('--output-format') + 1]).toBe('stream-json')
		expect(spec.stdin!.endsWith('\n')).toBe(true)
		expect(JSON.parse(spec.stdin!)).toEqual({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'Cut the pauses' },
					{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }
				]
			}
		})
		// No pictures: exactly the old command line, and nothing on stdin.
		const plain = buildCommand({ ...base, engine: 'claude-code', images: [] })
		expect(plain.args.slice(0, 2)).toEqual(['-p', 'Cut the pauses'])
		expect(plain.stdin).toBeUndefined()
	})

	it('Windows paths', () => {
		const spec = buildCommand({ ...base, engine: 'claude-code', workDir: 'C:\\Temp\\run', pathSep: '\\' })
		expect(spec.args[spec.args.indexOf('--mcp-config') + 1]).toBe('C:\\Temp\\run\\mcp.json')
	})
})

describe('prompts', () => {
	it('system prompt carries the baseline and the step budget, and no opinion of its own', () => {
		const text = buildEngineSystemPrompt({ maxSteps: 12, engineLabel: 'Claude Code' })
		expect(text).toMatch(/at most 12 tool calls/)
		expect(text).toContain(FRAMEFLOW_BASELINE)
		expect(text).not.toMatch(/persona|prefer a few|focused calls/i)
		// Rounds are for outside agents: telling the engine to begin one only errors.
		expect(text).not.toMatch(/begin_round/)
	})

	it('sends an agent to the motion guide before it writes a page, and knows the tool is FrameFlow’s', () => {
		const text = buildEngineSystemPrompt({ maxSteps: 5, engineLabel: 'Claude Code' })
		expect(text).toMatch(/get_motion_guide first if you will write an HTML motion page/)
		expect(isFrameflowTool('get_motion_guide', null)).toBe(true)
	})

	it('user prompt carries the scope', () => {
		expect(buildEngineUserPrompt({ prompt: 'Trim it', playheadSec: 63, selectedItemIds: ['a', 'b'] }))
			.toBe('Trim it\n\n---\nPlayhead: 1:03.0. Scope: the selected timeline items (a, b). Change only them unless the request needs more.')
		expect(buildEngineUserPrompt({ prompt: 'x', playheadSec: 0, selectedItemIds: ['a'], widen: 'full' })).toMatch(/whole timeline/)
	})

	it('user prompt carries what its references are, between the words and the scope', () => {
		expect(buildEngineUserPrompt({ prompt: 'Cut at @0:05.0 ', playheadSec: 5, selectedItemIds: [], references: 'References in this message:\n- @0:05.0 = timeline 5.000s' }))
			.toBe('Cut at @0:05.0\n\nReferences in this message:\n- @0:05.0 = timeline 5.000s\n\n---\nPlayhead: 0:05.0. Scope: whatever the request needs.')
		expect(buildEngineUserPrompt({ prompt: 'x', playheadSec: 0, selectedItemIds: [], references: '  ' })).not.toMatch(/References/)
	})

	it('every engine says whether it takes pictures', () => {
		for (const meta of Object.values(ENGINES)) expect(typeof meta.images).toBe('boolean')
	})
})

describe('Retry on a failed engine run', () => {
	const request = { selectedItemIds: ['clip-1', 'clip-2'], playheadSec: 12.5, widen: 'full' as const }
	const turn = (patch: Partial<PromptTurn> = {}, end: 'failed' | 'cancelled' | 'none' = 'failed'): PromptTurn => ({
		id: 't1', prompt: 'tighten the intro', baseStepId: 's', status: 'error', createdAt: 100,
		engine: { id: 'claude-code', label: 'Claude Code', steps: [], request, end: end === 'none' ? undefined : end },
		...patch
	})

	it('re-sends the same prompt, selection, playhead and widen on the same engine', () => {
		const t = turn()
		expect(engineRetry(t, [t])).toEqual({ engine: 'claude-code', prompt: 'tighten the intro', ...request })
	})

	it('re-sends the frames the message carried', () => {
		const attachments = [{ id: 'f1', timeSec: 3, note: 'too big', path: '/p/f1.jpg', thumbnail: 'data:' }]
		const t = turn({ attachments })
		expect(engineRetry(t, [t])?.attachments).toEqual(attachments)
	})

	it('is offered when edits landed before it failed (a completed turn with a failure note)', () => {
		const t = turn({ status: 'completed', notes: ['Claude Code did not finish.'] })
		expect(engineRetry(t, [t])).not.toBeNull()
	})

	it('is not offered after the user stopped it, or for a run that finished', () => {
		const stopped = turn({}, 'cancelled')
		expect(engineRetry(stopped, [stopped])).toBeNull()
		const fine = turn({ status: 'completed' }, 'none')
		expect(engineRetry(fine, [fine])).toBeNull()
	})

	it('is not offered while running, for a Gemini API turn, or without the recorded request', () => {
		const running = turn({ status: 'running' })
		expect(engineRetry(running, [running])).toBeNull()
		const api = turn({ engine: undefined })
		expect(engineRetry(api, [api])).toBeNull()
		const old = turn({ engine: { id: 'claude-code', label: 'Claude Code', steps: [], end: 'failed' } })
		expect(engineRetry(old, [old])).toBeNull()
		expect(engineRetry(undefined, [])).toBeNull()
	})

	it('only the newest chat turn offers it; the run’s own edit turns do not count', () => {
		const failed = turn()
		const edit = turn({ id: 'e1', createdAt: 150, engine: undefined, status: 'completed', agent: { name: 'Claude Code', sessionId: 's', engineTurnId: 't1' } })
		expect(engineRetry(failed, [failed, edit])).not.toBeNull()
		const later = turn({ id: 't2', createdAt: 200, engine: undefined, status: 'completed' })
		expect(engineRetry(failed, [failed, later])).toBeNull()
	})
})

describe('engine chip', () => {
	const base = { engine: 'claude-code' as const, models: {}, efforts: {}, maxSteps: 20 }

	it('names the CLI model, or just the CLI when it uses its own', () => {
		expect(engineChipLabel({ ...base, models: { 'claude-code': 'claude-opus-5-5' } })).toBe('Claude Code · Opus 5.5')
		expect(engineChipLabel(base)).toBe('Claude Code')
		expect(engineChipLabel({ ...base, models: { 'claude-code': 'claude-opus-5-5' }, efforts: { 'claude-code': 'xhigh' } })).toBe('Claude Code · Opus 5.5 · Extra high')
		expect(engineChipLabel({ ...base, efforts: { 'claude-code': 'high' } })).toBe('Claude Code · High')
		expect(engineChipLabel({ ...base, models: { 'claude-code': 'claude-x-9' } })).toBe('Claude Code · claude-x-9')
	})

	it('shortens to the model, or to the engine when no model is set', () => {
		expect(engineChipShort({ ...base, models: { 'claude-code': 'claude-opus-5-5' }, efforts: { 'claude-code': 'xhigh' } })).toBe('Opus 5.5')
		expect(engineChipShort({ ...base, efforts: { 'claude-code': 'high' } })).toBe('Claude Code')
		expect(engineChipShort({ ...base, engine: 'gemini-api' }, 'Gemini 3 Flash Preview')).toBe('3 Flash Preview')
	})

	it('names the Gemini model without the repeated brand', () => {
		expect(engineChipLabel({ ...base, engine: 'gemini-api' }, 'Gemini 3 Flash Preview')).toBe('Gemini API · 3 Flash Preview')
		expect(engineChipLabel({ ...base, engine: 'gemini-api' })).toBe('Gemini API')
	})
})

describe('geminiTextModels', () => {
	const pricing = {
		'a-pro': { input: { standard: 1.25 } },
		'b-flash': { input: { text: 0.3, standard: 0.3 } },
		'c-image': { input: { standard: 0.5 }, output: { image: 0.07 } },
		'gemini-3.5-transcribe': { input: { standard: 2 } }
	}
	it('drops image and speech-to-text models, orders as asked, falls back to price', () => {
		const meta = { 'a-pro': { label: 'A Pro' } }
		expect(geminiTextModels(pricing, meta, ['b-flash']).map((m) => m.value)).toEqual(['b-flash', 'a-pro'])
		expect(geminiTextModels(pricing, meta)).toEqual([
			{ value: 'b-flash', label: 'b-flash', inputPerM: 0.3 },
			{ value: 'a-pro', label: 'A Pro', inputPerM: 1.25 }
		])
	})
})

describe('reusing the CLI conversation', () => {
	const base = { prompt: 'Make it shorter', systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:5555/mcp', workDir: '/tmp/run' }
	const chat = (id: string, createdAt: number, sessionId?: string, extra: Partial<PromptTurn> = {}): PromptTurn => ({
		id, prompt: 'p', baseStepId: 'b', status: 'completed', createdAt,
		engine: { id: 'claude-code', label: 'Claude Code', steps: [], sessionId }, ...extra
	}) as PromptTurn

	it('reads the conversation id from the CLI start line', () => {
		expect(track('claude-code', fixture('claude.stream.jsonl')).sessionId).toBeTruthy()
	})

	it('leaves nothing on disk unless the run asks to keep its conversation', () => {
		expect(buildCommand({ ...base, engine: 'claude-code' }).args).toContain('--no-session-persistence')
		const kept = buildCommand({ ...base, engine: 'claude-code', keepSession: true }).args
		expect(kept).not.toContain('--no-session-persistence')
		expect(kept).not.toContain('--resume')
	})

	it('resumes the given conversation, which also keeps it', () => {
		const a = buildCommand({ ...base, engine: 'claude-code', resumeSessionId: 'abc-123' }).args
		expect(a[a.indexOf('--resume') + 1]).toBe('abc-123')
		expect(a).not.toContain('--no-session-persistence')
	})

	it('continues the conversation the newest chat turn was part of', () => {
		const turns = [
			chat('old', 1, 'first'), chat('new', 5, 'second'),
			// An edit the engine made belongs to its chat turn and is not a conversation of its own.
			chat('edit', 12, 'edit-session', { agent: { engineTurnId: 'new' } as any })
		]
		expect(resumableSessionId(turns, 'claude-code')).toBe('second')
		expect(resumableSessionId([], 'claude-code')).toBeUndefined()
		expect(resumableSessionId(undefined, 'claude-code')).toBeUndefined()
		// The asking run's own turn is not the one before it.
		expect(resumableSessionId([...turns, chat('now', 20, undefined)], 'claude-code', 'now')).toBe('second')
	})

	it('"New conversation" clears the newest turn\'s id, and nothing reaches back to an older one', () => {
		const turns = [chat('old', 1, 'first'), chat('new', 5, undefined)]
		expect(resumableSessionId(turns, 'claude-code')).toBeUndefined()
		expect(latestEngineTurn(turns, 'claude-code')?.id).toBe('new')
		// Another engine's turns are not this engine's conversation.
		expect(latestEngineTurn([{ ...chat('g', 9, 'x'), engine: undefined } as PromptTurn], 'claude-code')).toBeUndefined()
	})

	it('tells a continued conversation the project may have changed', () => {
		const input = { prompt: 'Shorter', playheadSec: 3, selectedItemIds: [] }
		expect(buildEngineUserPrompt(input)).not.toMatch(/may have changed/)
		expect(buildEngineUserPrompt({ ...input, resuming: true })).toMatch(/may have changed/)
	})

	it('starts fresh once when a resume dies before doing anything, but not for a sign-in or a stop', () => {
		const dead = { ok: false, cancelled: false, note: null, steps: [], commits: [] }
		expect(shouldRestartFresh(true, dead)).toBe(true)
		expect(shouldRestartFresh(false, dead)).toBe(false)
		expect(shouldRestartFresh(true, { ...dead, note: 'Sign in again' })).toBe(false)
		expect(shouldRestartFresh(true, { ...dead, cancelled: true })).toBe(false)
		expect(shouldRestartFresh(true, { ...dead, steps: [{}] })).toBe(false)
		expect(shouldRestartFresh(true, { ...dead, ok: true })).toBe(false)
	})
})

describe('the loop engine\u2019s prompt', () => {
	it('adds the plan and cost lines only for an engine that runs the loop', () => {
		const cli = buildEngineSystemPrompt({ maxSteps: 20, engineLabel: 'Claude Code' })
		const loop = buildEngineSystemPrompt({ maxSteps: 20, engineLabel: 'Gemini API', planTool: true, metered: true })
		expect(cli).not.toMatch(/update_plan|sends this whole conversation/)
		expect(loop).toMatch(/update_plan/)
		expect(loop).toMatch(/sends this whole conversation/)
		// Same baseline either way.
		expect(loop).toContain(FRAMEFLOW_BASELINE)
	})

	it('titles the plan step with where the agent is in it', () => {
		expect(stepTitle('update_plan', { items: [{ step: 'Cut the pauses', status: 'in_progress' }, { step: 'Check', status: 'pending' }] })).toBe('plan · 0/2 · Cut the pauses')
		expect(stepTitle('update_plan', { items: [{ step: 'Cut', status: 'completed' }, { step: 'Check', status: 'in_progress' }] })).toBe('plan · 1/2 · Check')
		expect(stepTitle('update_plan', {})).toBe('plan')
	})

	it('knows which engines run in FrameFlow and which are CLIs', () => {
		expect(isLoopEngine('gemini-api')).toBe(true)
		expect(isLoopEngine('claude-code')).toBe(false)
		expect(isCliEngine('gemini-api')).toBe(false)
	})

	it('finds and resumes a conversation for either kind of engine', () => {
		const turn = (id: string, engine: 'claude-code' | 'gemini-api', createdAt: number, sessionId?: string) =>
			({ id, prompt: 'p', baseStepId: 'b', status: 'completed', createdAt, engine: { id: engine, label: engine, steps: [], sessionId } }) as any
		const turns = [turn('a', 'gemini-api', 1, 'g1'), turn('b', 'claude-code', 2, 'c1'), turn('c', 'gemini-api', 3, 'g2')]
		expect(resumableSessionId(turns, 'gemini-api')).toBe('g2')
		expect(resumableSessionId(turns, 'claude-code')).toBe('c1')
	})
})
