import type { PromptTurn } from './types'

/**
 * One revision per request.
 *
 * A request is what the person asked for once: a chat turn FrameFlow's own
 * assistant runs, or an outside agent's round (begin_round … end_round). It may
 * take the agent a dozen edits; the person still asked once, so the Revisions
 * panel gets ONE revision for it, which each later edit rewrites in place (same
 * id, same V number, same place in the tree). Switching versions is then a
 * matter of "before what I asked" and "after", request by request.
 *
 * The agent names that revision ("Tighter intro, music under"): a few words on
 * what the request became, shown in place of the agent's name.
 */

export const VERSION_NAME_MAX = 60

/** A name an agent gave, cleaned: one line, trimmed, at most VERSION_NAME_MAX characters; undefined when empty. */
export function cleanVersionName(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const one = raw.replace(/\s+/g, ' ').trim()
	if (!one) return undefined
	return one.length > VERSION_NAME_MAX ? `${one.slice(0, VERSION_NAME_MAX - 1).trimEnd()}…` : one
}

/**
 * Which request an agent's edit belongs to: the outside agent's open round, or
 * the chat turn of FrameFlow's own assistant. None for a person's own edit, or
 * an outside agent editing outside a round.
 */
export const requestKeyOf = (turn: Pick<PromptTurn, 'agent'>, roundId?: string | null): string | undefined =>
	roundId || turn.agent?.engineTurnId || undefined

/**
 * Whether an edit rewrites its request's revision rather than adding one: while
 * that revision is the one being worked on, or the agent went back to where the
 * request started (its parent) and is trying again. Anywhere else, the agent
 * switched to another version on purpose, and the edit is a new revision there.
 */
export function rewritesRequestRevision(
	kept: { id: string; parentId: string | null } | undefined, currentRevisionId: string | null | undefined
): boolean {
	if (!kept || !currentRevisionId) return false
	return currentRevisionId === kept.id || currentRevisionId === kept.parentId
}

/**
 * The revision's label: the name the agent gave (this edit's, or one given
 * earlier in the same request); otherwise who made it, with the round's goal
 * when there is one ("Claude Code: cut the pauses").
 */
export function requestRevisionLabel(input: { name?: string; agent?: string; goal?: string }): string {
	if (input.name) return input.name
	const who = input.agent || 'AI edit'
	const goal = input.goal?.trim()
	return goal ? `${who}: ${goal.length > 60 ? `${goal.slice(0, 59)}…` : goal}` : who
}
