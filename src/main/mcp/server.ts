import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import {
	AGENT_DEFAULT_PORT, AGENT_MCP_PATH, AGENT_PORT_ATTEMPTS, AGENT_SERVER_NAME, checkRequest,
	displayClientName, permissionRefusal, type AgentPermission, type AgentPermissions
} from '@shared/agent'
import type { AgentActivity, AgentSessionInfo } from '@shared/agentFeed'
import type { EditorBridge } from './bridge'
import { SERVER_INSTRUCTIONS, ToolError, TOOLS, type ToolContext, type ToolDef } from './tools'

/**
 * FrameFlow's MCP server: Streamable HTTP on 127.0.0.1, one MCP `Server` per
 * client session so each knows who it is talking to.
 *
 * Every request passes the guard in @shared/agent first — Host and Origin
 * (DNS rebinding) then the bearer token — before the SDK sees it. The SDK's own
 * host checks are deprecated in favour of exactly this kind of outer check.
 *
 * No Electron here either; index.ts wires it to the app, and the integration
 * test runs it as is.
 */

export type AgentServerEvent =
	| { type: 'session'; session: AgentSessionInfo }
	| { type: 'session-closed'; session: AgentSessionInfo }
	| { type: 'activity'; activity: AgentActivity }

export interface AgentServerOptions {
	bridge: EditorBridge
	/** Read per request, so a new token takes effect at once. */
	token: () => string
	permissions: () => AgentPermissions
	version: string
	tools?: ToolDef[]
	onEvent?: (event: AgentServerEvent) => void
}

interface Session {
	info: AgentSessionInfo
	transport: StreamableHTTPServerTransport
	server: Server
}

/** A tool reply never needs more; anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

const REFUSED_SHORT: Record<AgentPermission, string> = {
	read: '', edit: 'refused · editing is off', html: 'refused · HTML motion is off', export: 'refused · exporting is off'
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let size = 0
		req.on('data', (chunk: Buffer) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Request too large'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined)
			} catch {
				reject(new Error('Body is not JSON'))
			}
		})
		req.on('error', reject)
	})
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
	if (res.headersSent) return
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/** "~/Projects/BytePets" from a root URI, for the Agent tab's header. */
function displayRoot(uri: string | undefined): string | undefined {
	if (!uri?.startsWith('file:')) return undefined
	try {
		const path = fileURLToPath(uri)
		const home = process.env.HOME || process.env.USERPROFILE
		return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
	} catch {
		return undefined
	}
}

export class AgentServer {
	private httpServer: http.Server | null = null
	private sessions = new Map<string, Session>()
	private writeChain: Promise<unknown> = Promise.resolve()
	private readonly tools: ToolDef[]
	port: number | null = null

	constructor(private readonly options: AgentServerOptions) {
		this.tools = options.tools || TOOLS
	}

	get running(): boolean {
		return this.httpServer !== null
	}

	listSessions(): AgentSessionInfo[] {
		return [...this.sessions.values()].map((s) => ({ ...s.info }))
	}

	/**
	 * Binds 127.0.0.1 — never 0.0.0.0 — on the preferred port, walking up a few
	 * if it is taken, then taking whatever the OS offers. Returns the real port.
	 */
	async start(preferredPort = AGENT_DEFAULT_PORT): Promise<number> {
		if (this.httpServer && this.port !== null) return this.port
		const server = http.createServer((req, res) => {
			this.handle(req, res).catch((error) => {
				console.error('[mcp] request failed:', error)
				sendError(res, 500, 'Internal error')
			})
		})
		const listen = (port: number) => new Promise<number>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => reject(error)
			server.once('error', onError)
			server.listen(port, '127.0.0.1', () => {
				server.off('error', onError)
				resolve((server.address() as AddressInfo).port)
			})
		})
		let port: number | null = null
		const candidates = preferredPort === 0
			? []
			: Array.from({ length: AGENT_PORT_ATTEMPTS }, (_, i) => preferredPort + i)
		for (const candidate of candidates) {
			try {
				port = await listen(candidate)
				break
			} catch (error: any) {
				if (error?.code !== 'EADDRINUSE') throw error
			}
		}
		if (port === null) port = await listen(0)
		this.httpServer = server
		this.port = port
		return port
	}

	async stop(): Promise<void> {
		await this.disconnectAll()
		const server = this.httpServer
		this.httpServer = null
		this.port = null
		if (!server) return
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}

	async disconnect(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session) return false
		await session.transport.close().catch(() => { /* already gone */ })
		this.closeSession(sessionId)
		return true
	}

	async disconnectAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)))
	}

	// ===== HTTP =====

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
		if (path !== AGENT_MCP_PATH) return sendError(res, 404, `Not found. FrameFlow's MCP endpoint is ${AGENT_MCP_PATH}.`)

		const guard = checkRequest({
			host: req.headers.host,
			origin: req.headers.origin,
			authorization: req.headers.authorization
		}, { port: this.port ?? 0, token: this.options.token() })
		if (!guard.ok) return sendError(res, guard.status, guard.message)

		let body: unknown
		if (req.method === 'POST') {
			try {
				body = await readJson(req)
			} catch (error: any) {
				return sendError(res, 400, error?.message || 'Bad request')
			}
		}

		const sessionHeader = req.headers['mcp-session-id']
		const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader
		if (sessionId) {
			const session = this.sessions.get(sessionId)
			if (!session) return sendError(res, 404, 'Session not found: it was disconnected from FrameFlow. Reconnect to continue.')
			return session.transport.handleRequest(req, res, body)
		}
		if (req.method === 'POST' && isInitializeRequest(body)) {
			const transport = await this.openSession()
			return transport.handleRequest(req, res, body)
		}
		return sendError(res, 400, 'No session: send an initialize request first.')
	}

	// ===== Sessions =====

	private async openSession(): Promise<StreamableHTTPServerTransport> {
		const server = new Server(
			{ name: AGENT_SERVER_NAME, title: 'FrameFlow', version: this.options.version },
			{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
		)
		const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				const now = Date.now()
				this.sessions.set(id, {
					info: { id, clientName: 'An agent', connectedAt: now, lastActivityAt: now, steps: 0 },
					transport, server
				})
			}
		})
		transport.onclose = () => {
			if (transport.sessionId) this.closeSession(transport.sessionId)
		}

		// clientInfo arrives with initialize; the session is announced once the
		// client confirms with `initialized`, named after what it said it was.
		server.oninitialized = () => {
			const session = transport.sessionId ? this.sessions.get(transport.sessionId) : undefined
			if (!session) return
			const client = server.getClientVersion()
			session.info.clientName = displayClientName(client)
			session.info.clientVersion = client?.version
			this.emit({ type: 'session', session: { ...session.info } })
			if (server.getClientCapabilities()?.roots) {
				server.listRoots(undefined, { timeout: 5_000 })
					.then(({ roots }) => {
						session.info.root = displayRoot(roots[0]?.uri)
						if (session.info.root) this.emit({ type: 'session', session: { ...session.info } })
					})
					.catch(() => { /* roots are a nicety */ })
			}
		}

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any }))
		}))
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const session = transport.sessionId ? this.sessions.get(transport.sessionId) : undefined
			if (!session) return { content: [{ type: 'text', text: 'Session closed.' }], isError: true }
			return this.callTool(session, request.params.name, (request.params.arguments || {}) as Record<string, any>)
		})

		await server.connect(transport)
		return transport
	}

	private closeSession(sessionId: string): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		this.sessions.delete(sessionId)
		void session.server.close().catch(() => { /* closing anyway */ })
		this.emit({ type: 'session-closed', session: { ...session.info } })
	}

	// ===== Tool calls =====

	private async callTool(session: Session, name: string, args: Record<string, any>) {
		const def = this.tools.find((t) => t.name === name)
		if (!def) {
			return { content: [{ type: 'text' as const, text: `Unknown tool "${name}". Tools: ${this.tools.map((t) => t.name).join(', ')}.` }], isError: true }
		}

		session.info.steps++
		session.info.lastActivityAt = Date.now()
		this.emit({ type: 'session', session: { ...session.info } })

		let activity: AgentActivity = {
			id: randomUUID(),
			sessionId: session.info.id,
			tool: name,
			title: safeTitle(def, args),
			status: 'running',
			startedAt: Date.now()
		}
		this.emit({ type: 'activity', activity })
		const finish = (patch: Partial<AgentActivity>) => {
			activity = { ...activity, ...patch, endedAt: Date.now() }
			this.emit({ type: 'activity', activity })
		}

		const refusal = permissionRefusal(def.permission, this.options.permissions())
		if (refusal) {
			finish({ status: 'refused', detail: REFUSED_SHORT[def.permission] })
			return { content: [{ type: 'text' as const, text: refusal }], isError: true }
		}

		const ctx: ToolContext = {
			sessionId: session.info.id,
			clientName: session.info.clientName,
			bridge: this.options.bridge,
			permissions: this.options.permissions
		}
		try {
			const run = () => def.run(args, ctx)
			const out = def.writes ? await this.serialize(run) : await run()
			finish({
				...out.feed,
				title: out.feed.title || activity.title,
				status: out.isError ? 'error' : 'done'
			})
			return { content: out.content, isError: out.isError }
		} catch (error: any) {
			const message = error instanceof ToolError
				? error.message
				: `FrameFlow could not finish ${name}: ${error?.message || error}`
			finish({ status: 'error', detail: message.split('\n')[0] })
			return { content: [{ type: 'text' as const, text: message }], isError: true }
		}
	}

	/**
	 * One write at a time across every session: each reads the live document
	 * the previous one left, so two agents cannot build diffs off the same base.
	 */
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(work, work)
		this.writeChain = next.catch(() => undefined)
		return next
	}

	private emit(event: AgentServerEvent): void {
		try {
			this.options.onEvent?.(event)
		} catch (error) {
			console.error('[mcp] event listener failed:', error)
		}
	}
}

function safeTitle(def: ToolDef, args: Record<string, any>): string {
	try {
		return def.title?.(args) || def.name
	} catch {
		return def.name
	}
}
