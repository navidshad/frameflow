import { probeMotionPage } from '../motion/probe'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import {
	AGENT_DEFAULT_PORT, AGENT_MCP_PATH, connectSnippet, maskToken,
	type AgentClientKind, type AgentPermissions
} from '@shared/agent'
import type { AgentAccessState } from '@shared/agentFeed'
import { settingsManager } from '../settings'
import { AgentServer, type AgentServerEvent } from './server'
import { installRendererBridge, lastProjectTitle, rendererBridge } from './rendererBridge'
import { requestedTokenFile, writeTokenFile } from './tokenFile'

/**
 * Agent access, wired to the app: the Settings card's IPC, the server's
 * lifecycle, and the events the Agent tab draws from.
 *
 * Off by default. Turning it on starts the server and remembers that, so it
 * comes back on the next launch; turning it off stops it and drops every
 * client.
 */

let server: AgentServer | null = null
let lastError: string | undefined

/** Where the launcher asked for the token to be written (`--agent-token-file`); null = nowhere. */
const tokenFile = requestedTokenFile(process.argv, process.env)

function exportTokenFile(): void {
	if (!tokenFile) return
	try {
		writeTokenFile(tokenFile, settingsManager.getAgentToken())
		console.log(`[mcp] agent token written to ${tokenFile}`)
	} catch (error: any) {
		console.error(`[mcp] could not write the agent token to ${tokenFile}: ${error?.code || error?.message || error}`)
	}
}

const url = (port: number | null) => (port ? `http://127.0.0.1:${port}${AGENT_MCP_PATH}` : null)

function state(): AgentAccessState {
	const access = settingsManager.getAgentAccess()
	const token = settingsManager.getAgentToken()
	const port = server?.port ?? null
	return {
		enabled: access.enabled,
		running: !!server?.running,
		port,
		url: url(port) ?? (access.enabled ? null : `http://127.0.0.1:${AGENT_DEFAULT_PORT}${AGENT_MCP_PATH}`),
		tokenMasked: maskToken(token),
		tokenShort: maskToken(token, 4),
		permissions: access.permissions,
		sessions: (server?.listSessions() ?? []).map((session) => ({ ...session, project: lastProjectTitle || undefined })),
		recent: access.recent,
		error: lastError
	}
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, payload)
	}
}

const broadcastState = () => broadcast('agent-access-state', state())

function onServerEvent(event: AgentServerEvent): void {
	if (event.type === 'activity') {
		broadcast('agent-activity', event.activity)
		return
	}
	if (event.type === 'session-closed' && event.session.steps > 0) {
		settingsManager.recordAgentSession({
			clientName: event.session.clientName,
			project: lastProjectTitle || '—',
			startedAt: event.session.connectedAt,
			steps: event.session.steps
		})
	}
	broadcastState()
}

async function start(): Promise<void> {
	if (server?.running) return
	lastError = undefined
	const next = new AgentServer({
		bridge: rendererBridge,
		token: () => settingsManager.getAgentToken(),
		permissions: () => settingsManager.getAgentAccess().permissions,
		version: app.getVersion(),
		probeMotion: probeMotionPage,
		onEvent: onServerEvent
	})
	try {
		const port = await next.start(AGENT_DEFAULT_PORT)
		server = next
		console.log(`[mcp] agent access on ${url(port)}`)
	} catch (error: any) {
		lastError = `Could not start the agent server: ${error?.message || error}`
		console.error('[mcp]', lastError)
	}
}

async function stop(): Promise<void> {
	const current = server
	server = null
	await current?.stop()
}

export function initAgentAccess(): void {
	installRendererBridge()
	exportTokenFile()

	ipcMain.handle('get-agent-access', () => state())

	ipcMain.handle('set-agent-access-enabled', async (_event, enabled: boolean) => {
		settingsManager.updateAgentAccess({ enabled: !!enabled })
		if (enabled) await start()
		else await stop()
		broadcastState()
		return state()
	})

	ipcMain.handle('set-agent-permission', (_event, { key, value }: { key: keyof AgentPermissions; value: boolean }) => {
		if (!['edit', 'html', 'export', 'sound', 'generate'].includes(key)) return state()
		const permissions = { ...settingsManager.getAgentAccess().permissions, [key]: !!value }
		settingsManager.updateAgentAccess({ permissions })
		broadcastState()
		return state()
	})

	// The token never crosses into the renderer: main writes it to the clipboard.
	ipcMain.handle('copy-agent-token', () => {
		clipboard.writeText(settingsManager.getAgentToken())
		return true
	})

	ipcMain.handle('copy-agent-snippet', (_event, kind: AgentClientKind) => {
		const address = url(server?.port ?? null) ?? `http://127.0.0.1:${AGENT_DEFAULT_PORT}${AGENT_MCP_PATH}`
		clipboard.writeText(connectSnippet(kind, address, settingsManager.getAgentToken()))
		return true
	})

	ipcMain.handle('new-agent-token', async () => {
		settingsManager.newAgentToken()
		exportTokenFile()
		await server?.disconnectAll()
		broadcastState()
		return state()
	})

	ipcMain.handle('disconnect-agent-session', async (_event, sessionId: string) => {
		const done = (await server?.disconnect(sessionId)) ?? false
		broadcastState()
		return done
	})

	app.on('before-quit', () => {
		void stop()
	})

	if (settingsManager.getAgentAccess().enabled) {
		void start().then(broadcastState)
	}
}
