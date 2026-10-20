import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	agentFocus, buildCommand, buildEngineSystemPrompt, buildEngineUserPrompt, CODEX_DISABLED_FEATURES, displayPath,
	editTime, engineFailureNote, geminiAuthType, lineSplitter, normalizeEngineSettings, normalizeToolName,
	parseClaudeAuth, parseCodexConfigModel, parseCodexLogin, parseCodexModels, parseStreamLine, parseVersion,
	StepTracker, stepTitle, TOKEN_ENV, unexpectedTools, type CliEngineId
} from './engines'

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

	it('Codex: MCP calls by server, agent messages, turn.completed', () => {
		const t = track('codex', fixture('codex.stream.jsonl'))
		expect(t.steps.map((s) => s.title)).toEqual(['get_project', 'search_moments “faster”', 'apply_ops addMarkers @ 0:24.0'])
		expect(t.steps.every((s) => s.status === 'done')).toBe(true)
		expect(t.done?.ok).toBe(true)
		expect(t.answer).toMatch(/V2/)
	})

	it('Gemini CLI: a failed run ends with its error', () => {
		const t = track('gemini-cli', fixture('gemini-badkey.stream.jsonl'))
		expect(t.model).toBe('auto')
		expect(t.steps).toEqual([])
		expect(t.done?.ok).toBe(false)
		expect(t.done?.error).toMatch(/API key not valid/)
		expect(engineFailureNote('gemini-cli', t.done!.error!)).toMatch(/API key was rejected/)
	})

	it('Gemini CLI: tool calls and streamed text (shape from its stream formatter)', () => {
		const t = track('gemini-cli', fixture('gemini-tools.synthetic.jsonl'))
		expect(t.steps.map((s) => [s.title, s.status])).toEqual([
			['get_project', 'done'],
			['render_frame 0:04.2 — checked', 'done'],
			['run_shell_command — not allowed', 'error']
		])
		expect(t.foreignTools).toEqual(['run_shell_command'])
		expect(t.answer).toBe('Added the lower third at 0:03.0.')
		expect(t.done?.ok).toBe(true)
	})
})

describe('parsing edge cases', () => {
	it('ignores banners and broken JSON', () => {
		expect(parseStreamLine('gemini-cli', 'Warning: 256-color support not detected.')).toEqual([])
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

	it('Codex shell commands show up as foreign steps', () => {
		const events = parseStreamLine('codex', JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'ls' } }))
		const t = new StepTracker()
		events.forEach((e) => t.apply(e))
		expect(t.foreignTools).toEqual(['command_execution'])
	})

	it('normalises every CLI’s tool names', () => {
		expect(normalizeToolName('mcp__frameflow__get_media')).toEqual({ server: 'frameflow', tool: 'get_media' })
		expect(normalizeToolName('mcp_frameflow_render_frame')).toEqual({ server: 'frameflow', tool: 'render_frame' })
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
	it('versions from each CLI', () => {
		expect(parseVersion('2.1.231 (Claude Code)\n')).toBe('2.1.231')
		expect(parseVersion('codex-cli 0.152.0')).toBe('0.152.0')
		expect(parseVersion('0.46.0\n')).toBe('0.46.0')
		expect(parseVersion('nope')).toBeUndefined()
	})

	it('sign-in state where the CLI reports it', () => {
		expect(parseClaudeAuth('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true)
		expect(parseClaudeAuth('{"loggedIn": false}')).toBe(false)
		expect(parseClaudeAuth('garbage')).toBeNull()
		expect(parseCodexLogin('Logged in using ChatGPT\n', 0)).toBe(true)
		expect(parseCodexLogin('Not logged in\n', 1)).toBe(false)
		expect(geminiAuthType('{"security":{"auth":{"selectedType":"oauth-personal"}}}', {})).toBe('oauth-personal')
		expect(geminiAuthType(undefined, { GEMINI_API_KEY: 'x' })).toBe('gemini-api-key')
		expect(geminiAuthType('{}', {})).toBeNull()
	})

	it('Codex models and its configured model', () => {
		const json = JSON.stringify({ models: [
			{ slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
			{ slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' }
		] })
		expect(parseCodexModels(json)).toEqual([{ value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }])
		expect(parseCodexConfigModel('model = "gpt-5.6-luna"\n[mcp_servers.x]\nmodel = "no"')).toBe('gpt-5.6-luna')
		expect(parseCodexConfigModel('[profile]\nmodel = "no"')).toBeUndefined()
	})

	it('paths under home are shortened', () => {
		expect(displayPath('/Users/me/.local/bin/codex', '/Users/me')).toBe('~/.local/bin/codex')
		expect(displayPath('/opt/homebrew/bin/claude', '/Users/me')).toBe('/opt/homebrew/bin/claude')
		expect(displayPath('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
	})

	it('recognises the Gemini CLI personal-account refusal', () => {
		const stderr = 'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.'
		expect(engineFailureNote('gemini-cli', stderr)).toMatch(/personal Google accounts/)
		expect(engineFailureNote('codex', 'some other failure')).toBeNull()
	})
})

describe('settings', () => {
	it('clamps and fills', () => {
		expect(normalizeEngineSettings(undefined)).toEqual({ engine: 'gemini-api', models: {}, maxSteps: 20 })
		expect(normalizeEngineSettings({ engine: 'codex', maxSteps: 900, models: { codex: ' gpt-5.6-luna ', 'claude-code': '' } }))
			.toEqual({ engine: 'codex', models: { codex: 'gpt-5.6-luna' }, maxSteps: 50 })
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

	it('Codex: read-only sandbox, shell off, approved MCP, no model flag by default', () => {
		const a = buildCommand({ ...base, engine: 'codex' }).args
		expect(a.slice(0, 2)).toEqual(['exec', '--json'])
		expect(a[a.indexOf('-s') + 1]).toBe('read-only')
		for (const f of CODEX_DISABLED_FEATURES) expect(a).toContain(f)
		expect(a).toContain('mcp_servers.frameflow.default_tools_approval_mode="approve"')
		expect(a).toContain(`mcp_servers.frameflow.bearer_token_env_var="${TOKEN_ENV}"`)
		expect(a).toContain('developer_instructions="SYS"')
		expect(a).not.toContain('-m')
		expect(a[a.length - 1]).toBe('Cut the pauses')
	})

	it('Codex: instructions with quotes and newlines stay one TOML string', () => {
		const a = buildCommand({ ...base, engine: 'codex', systemPrompt: 'say "hi"\nnow' }).args
		expect(a).toContain('developer_instructions="say \\"hi\\"\\nnow"')
	})

	it('Gemini CLI: admin policy, allow-listed server, system prompt file', () => {
		const spec = buildCommand({ ...base, engine: 'gemini-cli', model: 'gemini-2.5-pro' })
		expect(spec.args.slice(0, 2)).toEqual(['-p', 'Cut the pauses'])
		expect(spec.args[spec.args.indexOf('--admin-policy') + 1]).toBe('/tmp/run/policy.toml')
		expect(spec.args[spec.args.indexOf('--allowed-mcp-server-names') + 1]).toBe('frameflow')
		expect(spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe('/tmp/run/settings.json')
		const policy = spec.files.find((f) => f.name === 'policy.toml')!.content
		expect(policy).toMatch(/toolName = "\*"\ndecision = "deny"/)
		expect(policy).toMatch(/mcpName = "frameflow"/)
		expect(spec.args.slice(-2)).toEqual(['-m', 'gemini-2.5-pro'])
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

	it('user prompt carries the scope', () => {
		expect(buildEngineUserPrompt({ prompt: 'Trim it', playheadSec: 63, selectedItemIds: ['a', 'b'] }))
			.toBe('Trim it\n\n---\nPlayhead: 1:03.0. Scope: the selected timeline items (a, b). Change only them unless the request needs more.')
		expect(buildEngineUserPrompt({ prompt: 'x', playheadSec: 0, selectedItemIds: ['a'], widen: 'full' })).toMatch(/whole timeline/)
	})
})
