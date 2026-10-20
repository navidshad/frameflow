import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	agentFocus, buildCommand, buildEngineSystemPrompt, buildEngineUserPrompt, displayPath, editTime,
	engineFailureNote, engineRetry, isFrameflowTool, lineSplitter, normalizeEngineSettings, normalizeToolName, parseClaudeAuth,
	parseStreamLine, parseVersion, readableError, StepTracker, stepTitle, TOKEN_ENV, unexpectedTools, type CliEngineId
} from './engines'
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
		expect(normalizeEngineSettings(undefined)).toEqual({ engine: 'gemini-api', models: {}, maxSteps: 20 })
		expect(normalizeEngineSettings({ engine: 'claude-code', maxSteps: 900, models: { 'claude-code': ' opus ' } }))
			.toEqual({ engine: 'claude-code', models: { 'claude-code': 'opus' }, maxSteps: 50 })
		expect(normalizeEngineSettings({ engine: 'claude-code', models: { 'claude-code': '' } }).models).toEqual({})
		expect(normalizeEngineSettings({ engine: 'nope' as any }).engine).toBe('gemini-api')
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
		const config = JSON.parse(spec.files[0].content)
		expect(config.mcpServers.frameflow).toEqual({ type: 'http', url: base.mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } })
		expect(JSON.stringify(spec)).not.toMatch(/ff_/)
	})

	it('Windows paths', () => {
		const spec = buildCommand({ ...base, engine: 'claude-code', workDir: 'C:\\Temp\\run', pathSep: '\\' })
		expect(spec.args[spec.args.indexOf('--mcp-config') + 1]).toBe('C:\\Temp\\run\\mcp.json')
	})
})

describe('prompts', () => {
	it('system prompt carries the persona and the step budget', () => {
		const text = buildEngineSystemPrompt({ persona: { name: 'Podcast editor', systemPrompt: 'Keep it tight.' }, maxSteps: 12, engineLabel: 'Claude Code' })
		expect(text).toMatch(/at most 12 tool calls/)
		expect(text).toMatch(/Keep it tight\.$/)
	})

	it('sends an agent to the motion guide before it writes a page, and knows the tool is FrameFlow’s', () => {
		const text = buildEngineSystemPrompt({ persona: { name: 'p', systemPrompt: 'x' }, maxSteps: 5, engineLabel: 'Claude Code' })
		expect(text).toMatch(/call get_motion_guide/)
		expect(isFrameflowTool('get_motion_guide', null)).toBe(true)
	})

	it('user prompt carries the scope', () => {
		expect(buildEngineUserPrompt({ prompt: 'Trim it', playheadSec: 63, selectedItemIds: ['a', 'b'] }))
			.toBe('Trim it\n\n---\nPlayhead: 1:03.0. Scope: the selected timeline items (a, b). Change only them unless the request needs more.')
		expect(buildEngineUserPrompt({ prompt: 'x', playheadSec: 0, selectedItemIds: ['a'], widen: 'full' })).toMatch(/whole timeline/)
	})
})

describe('Retry on a failed engine run', () => {
	const request = { selectedItemIds: ['clip-1', 'clip-2'], playheadSec: 12.5, widen: 'full' as const }
	const turn = (patch: Partial<PromptTurn> = {}, end: 'failed' | 'cancelled' | 'none' = 'failed'): PromptTurn => ({
		id: 't1', personaId: 'p', prompt: 'tighten the intro', baseStepId: 's', status: 'error', createdAt: 100,
		engine: { id: 'claude-code', label: 'Claude Code', steps: [], request, end: end === 'none' ? undefined : end },
		...patch
	})

	it('re-sends the same prompt, selection, playhead and widen on the same engine', () => {
		const t = turn()
		expect(engineRetry(t, [t])).toEqual({ engine: 'claude-code', prompt: 'tighten the intro', ...request })
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
