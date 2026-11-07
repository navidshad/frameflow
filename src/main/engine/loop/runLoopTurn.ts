import { createMCPClient } from '@ai-sdk/mcp'
import { isStepCount, ToolLoopAgent, type LanguageModel, type ModelMessage } from 'ai'
import { ENGINES, MCP_SERVER_KEY, PLAN_TOOL, StepTracker, type EngineId, type EngineStep } from '@shared/engines'
import type { AgentActivity } from '@shared/agentFeed'
import type { AgentPermissions } from '@shared/agent'
import type { Usage } from '@shared/types'
import type { MotionProbe } from '../../editor/vetHtml'
import type { EditorBridge } from '../../mcp/bridge'
import type { EngineRunResult } from '../runner'
import { createTurnSession, OVERRUN_GRACE } from '../turnSession'
import { compactMessages } from './compaction'
import { loopFailure } from './errors'
import { createPlanTool } from './plan'
import { addUsage, usageFrom } from './providers'

/**
 * One chat turn run by FrameFlow's own agent loop: any model that can call
 * tools, driven the way a CLI is.
 *
 * The turn gets the same private MCP server a CLI gets (see turnSession), and
 * the loop talks to it as an MCP client, so the tools, the permissions, the
 * step budget and the revision bookkeeping are the ones every other agent has.
 * The loop is the AI SDK's ToolLoopAgent; what this file adds is what makes it
 * behave like Claude Code in the chat: steps that stream into the turn card, a
 * budget that ends in an answer, a context kept small, a plan the agent can
 * write down, and an abort that stops at once.
 *
 * No Electron and no provider here: the model comes in as a value, so the tests
 * run it against a scripted one.
 */

export interface LoopRunOptions {
	engine: EngineId
	model: LanguageModel
	/** What the chat names as the model: "gemini-3.6-flash". */
	modelName: string
	prompt: string
	systemPrompt: string
	/** The conversation so far, from a resumed one; empty for a fresh start. */
	history: ModelMessage[]
	maxSteps: number
	bridge: EditorBridge
	/** The chat turn: apply_ops links its revisions to it. */
	turnId: string
	version: string
	signal: AbortSignal
	permissions: () => AgentPermissions
	probeMotion?: MotionProbe
	/** Called on every step change, with the model once it is known. */
	onSteps?: (steps: EngineStep[], model?: string) => void
	onActivity?: (activity: AgentActivity) => void
	/** Called after each model call with what it used. */
	onUsage?: (usage: Usage) => void
	/** Whole-run cap. Default 20 minutes. */
	timeoutMs?: number
}

export interface LoopRunResult extends EngineRunResult {
	/** The whole conversation after this turn, to save for the next. Unchanged when the turn did not finish. */
	messages: ModelMessage[]
	usage: Usage
}

const NO_USAGE: Usage = { promptTokens: 0, candidatesTokens: 0, thinkingTokens: 0, totalTokens: 0 }

/** The first sentence a failed MCP tool said, for the step's error. */
function toolError(output: any): string | undefined {
	const text = Array.isArray(output?.content) ? output.content.find((c: any) => c?.type === 'text')?.text : undefined
	return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
}

export async function runLoopTurn(options: LoopRunOptions): Promise<LoopRunResult> {
	const label = ENGINES[options.engine].label
	const abort = new AbortController()
	let stopReason: 'abort' | 'timeout' | 'overrun' | null = null
	const stop = (reason: NonNullable<typeof stopReason>) => {
		if (!stopReason) stopReason = reason
		abort.abort()
	}
	const onAbort = () => stop('abort')
	options.signal.addEventListener('abort', onAbort, { once: true })
	if (options.signal.aborted) stop('abort')
	const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 20 * 60_000)

	const session = createTurnSession({
		bridge: options.bridge,
		maxSteps: options.maxSteps,
		turnId: options.turnId,
		version: options.version,
		permissions: options.permissions,
		probeMotion: options.probeMotion,
		onActivity: options.onActivity,
		onOverrun: () => stop('overrun')
	})
	const tracker = new StepTracker()
	tracker.apply({ type: 'init', model: options.modelName })
	const emit = () => options.onSteps?.(tracker.steps.map((s) => ({ ...s })), tracker.model)

	const userMessage: ModelMessage = { role: 'user', content: options.prompt }
	let usage = NO_USAGE
	let produced: ModelMessage[] = []
	let failure: unknown
	let finished = false
	// FrameFlow's own tool calls so far. The plan is the agent's, not the budget's.
	let calls = 0
	let mcp: Awaited<ReturnType<typeof createMCPClient>> | null = null

	try {
		const port = await session.server.start(0)
		if (!stopReason) {
			mcp = await createMCPClient({
				transport: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${session.token}` } }
			})
			const tools = { ...(await mcp.tools()), ...createPlanTool() }
			const agent = new ToolLoopAgent({
				model: options.model,
				instructions: options.systemPrompt,
				tools,
				// A safety net behind the budget: the server refuses calls past the limit and
				// the step below turns tools off, so this only matters for a model that ignores both.
				stopWhen: isStepCount(options.maxSteps + OVERRUN_GRACE + 2),
				prepareStep: ({ messages }) => {
					const compacted = compactMessages(messages)
					const wrapUp = calls >= options.maxSteps
					if (compacted === messages && !wrapUp) return undefined
					// Out of calls: the next model turn is the answer.
					return { ...(compacted !== messages ? { messages: compacted } : {}), ...(wrapUp ? { toolChoice: 'none' as const } : {}) }
				},
				onToolExecutionStart: ({ toolCall }) => {
					if (toolCall.toolName !== PLAN_TOOL) calls++
					tracker.apply({
						type: 'tool-start', callId: toolCall.toolCallId, tool: toolCall.toolName, server: MCP_SERVER_KEY,
						args: (toolCall.input ?? {}) as Record<string, unknown>
					})
					emit()
				},
				onToolExecutionEnd: ({ toolCall, toolOutput }) => {
					const failed = toolOutput.type === 'tool-error' || (toolOutput as any).output?.isError === true
					tracker.apply({
						type: 'tool-end', callId: toolCall.toolCallId, ok: !failed,
						error: failed ? (toolOutput.type === 'tool-error' ? String((toolOutput as any).error?.message ?? (toolOutput as any).error) : toolError((toolOutput as any).output)) : undefined
					})
					emit()
				},
				onStepEnd: (step) => {
					const stepUsage = usageFrom(step.usage)
					usage = addUsage(usage, stepUsage)
					options.onUsage?.(stepUsage)
					if (step.text) tracker.apply({ type: 'text', text: step.text })
				}
			})
			const result = await agent.generate({ messages: [...options.history, userMessage], abortSignal: abort.signal })
			// Every step's messages, not only the last: this is what the next turn resumes from.
			produced = result.responseMessages as ModelMessage[]
			tracker.apply({ type: 'done', ok: true, text: result.text })
			finished = true
		}
	} catch (error) {
		failure = error
	} finally {
		clearTimeout(timer)
		options.signal.removeEventListener('abort', onAbort)
		await mcp?.close().catch(() => { /* already down */ })
		await session.server.stop().catch(() => { /* already down */ })
	}

	tracker.settle(stopReason === 'abort' ? 'Stopped' : 'Did not finish')
	emit()

	const base = {
		steps: tracker.steps, model: tracker.model, commits: session.commits, finalRevisionId: session.finalRevisionId(),
		exitCode: null, stderr: '', usage,
		// A turn that did not finish leaves the conversation as it was: no half-done calls to resume from.
		messages: options.history
	}
	if (stopReason === 'abort') return { ...base, ok: false, cancelled: true, answer: tracker.answer, error: 'Cancelled' }
	if (stopReason === 'timeout') return { ...base, ok: false, cancelled: false, answer: tracker.answer, error: `${label} took too long and was stopped.` }
	if (stopReason === 'overrun' || session.overrun()) {
		return { ...base, ok: false, cancelled: false, answer: tracker.answer, error: `${label} kept calling tools past the ${options.maxSteps}-step limit and was stopped.` }
	}
	if (failure || !finished) {
		const f = loopFailure(failure, label, options.modelName)
		return { ...base, ok: false, cancelled: false, answer: tracker.answer, note: f.note, error: f.error }
	}
	return { ...base, ok: true, cancelled: false, answer: tracker.answer, note: null, messages: [...options.history, userMessage, ...produced] }
}
