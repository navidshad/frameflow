import { BrowserWindow } from 'electron'
import type { PromptTurn } from '@shared/types'
import { threadManager } from '../threads'

/**
 * How a chat turn reaches the renderer and the project file.
 *
 * The turn itself is run by an engine (see engine/index.ts): an agent loop over
 * FrameFlow's MCP tools, whose edits are revisions already. What is left here is
 * the plumbing every turn shares: streaming its state over `editor-turn-update`
 * and saving it with the project.
 */

/**
 * Streams a turn to every window. `replyId` asks the renderer to report back once
 * it has applied the turn (see mcp/rendererBridge.ts); an engine's own chat turn
 * never sets it, only the agent turns that carry its edits.
 */
export function emitTurnUpdate(payload: {
	threadId: string
	turn: PromptTurn
	addMarkers?: { time: number; label: string }[]
	docSettings?: { captionsEnabled?: boolean; loudnessEnabled?: boolean; frame?: { width: number; height: number } }
	/** Assets the turn refers to that the renderer may not have yet (rendered sounds). */
	addAssets?: import('../../shared/types').MediaAsset[]
	thinContext?: boolean
	truncated?: boolean
	replyId?: string
}) {
	BrowserWindow.getAllWindows().forEach((win) => {
		win.webContents.send('editor-turn-update', payload)
	})
}

export async function persistTurn(threadId: string, turn: PromptTurn): Promise<void> {
	await threadManager.updateThreadWith(threadId, (thread) => {
		if (!thread.editor) return null
		const turns = [...thread.editor.turns]
		const index = turns.findIndex((t) => t.id === turn.id)
		if (index === -1) turns.push(turn)
		else turns[index] = turn
		return { editor: { ...thread.editor, turns } }
	})
}
