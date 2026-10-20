import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import os from 'os'
import { randomBytes } from 'crypto'
import { EditorPersona, ModelSettings } from '../shared/types'
import { normalizePermissions, TOKEN_PREFIX, type AgentPermissions } from '../shared/agent'
import type { AgentRecentSession } from '../shared/agentFeed'
import { DEFAULT_MODEL_SETTINGS } from './constants/gemini'
import { BUILTIN_PERSONAS } from './constants/personas'

interface Settings {
	tempDir: string
	/** In memory only. On disk it is `geminiApiKeyEnc`. */
	geminiApiKey?: string
	modelSettings?: ModelSettings
	/** User-defined editor personas ONLY — built-ins are merged at read time. */
	personas?: EditorPersona[]
	/** MCP agent access. Off unless the user turns it on in Settings. */
	agentAccess?: AgentAccessSettings
	/** In memory only. On disk it is `agentTokenEnc`, encrypted like the API key. */
	agentToken?: string
}

export interface AgentAccessSettings {
	enabled: boolean
	permissions: AgentPermissions
	recent: AgentRecentSession[]
}

const RECENT_AGENT_SESSIONS = 10

const normalizeAgentAccess = (value: any): AgentAccessSettings => ({
	enabled: value?.enabled === true,
	permissions: normalizePermissions(value?.permissions),
	recent: Array.isArray(value?.recent) ? value.recent.slice(0, RECENT_AGENT_SESSIONS) : []
})

/**
 * The API key, encrypted at rest with the OS keychain.
 *
 * `settings.json` sits in userData with ordinary file permissions: readable by
 * anything running as the user, backed up, and synced by whatever the user has
 * syncing their home directory. A billable key does not belong there in plain
 * text.
 *
 * `safeStorage` is Electron's wrapper over Keychain on macOS, DPAPI on Windows
 * and the desktop keyring on Linux. It can be UNAVAILABLE — a Linux session
 * with no keyring, notably — and the honest fallback there is to keep working
 * with the key in plain text rather than to lose it, because a key that
 * silently stops working is worse than one stored the way it was yesterday.
 * The file records WHICH it is, so a key never gets read back as the wrong one.
 */
const encryptKey = (key: string): { enc?: string; plain?: string } => {
	if (!key) return {}
	try {
		if (safeStorage.isEncryptionAvailable()) {
			return { enc: safeStorage.encryptString(key).toString('base64') }
		}
	} catch (error) {
		console.warn('[SettingsManager] safeStorage unavailable, key stays in plain text:', error)
	}
	return { plain: key }
}

const decryptKey = (parsed: { geminiApiKeyEnc?: string; geminiApiKey?: string }): string | undefined => {
	if (parsed.geminiApiKeyEnc) {
		try {
			return safeStorage.decryptString(Buffer.from(parsed.geminiApiKeyEnc, 'base64'))
		} catch (error) {
			// A key encrypted on another machine, or after a keychain reset. It is
			// not recoverable, and saying so beats an authentication error later.
			console.error('[SettingsManager] Could not decrypt the stored API key:', error)
			return undefined
		}
	}
	return parsed.geminiApiKey
}

class SettingsManager {
	private settingsPath: string
	private settings: Settings
	private defaultTempDir: string

	constructor() {
		this.defaultTempDir = join(os.tmpdir(), 'FrameFlow')
		this.settings = {
			tempDir: this.defaultTempDir,
			modelSettings: DEFAULT_MODEL_SETTINGS
		}
		// settingsPath will be set in init()
		this.settingsPath = ''
	}

	public init() {
		try {
			const userDataPath = app.getPath('userData')
			this.settingsPath = join(userDataPath, 'settings.json')
			this.settings = this.loadSettings()
			// Migrate a key that predates encryption, on the first launch that
			// can do it. Waiting for the user to change some unrelated setting
			// would leave it in plain text indefinitely.
			if (this.settings.geminiApiKey && this.isKeyEncrypted()) {
				const raw = existsSync(this.settingsPath)
					? JSON.parse(readFileSync(this.settingsPath, 'utf-8'))
					: {}
				if (raw.geminiApiKey) {
					this.saveSettings()
					console.log('[SettingsManager] Encrypted the stored API key at rest.')
				}
			}
			console.log(`[SettingsManager] Initialized with userData: ${userDataPath}`)
		} catch (error) {
			console.error('[SettingsManager] Failed to initialize:', error)
		}
	}

	private mergeModelSettings(existing: ModelSettings): ModelSettings {
		return {
			pricing: { ...DEFAULT_MODEL_SETTINGS.pricing, ...existing.pricing },
			selection: { ...DEFAULT_MODEL_SETTINGS.selection, ...existing.selection }
		}
	}

	private loadSettings(): Settings {
		try {
			if (existsSync(this.settingsPath)) {
				const data = readFileSync(this.settingsPath, 'utf-8')
				const parsed = JSON.parse(data)
				return {
					tempDir: parsed.tempDir || this.defaultTempDir,
					geminiApiKey: decryptKey(parsed),
					modelSettings: this.mergeModelSettings(parsed.modelSettings || DEFAULT_MODEL_SETTINGS),
					personas: Array.isArray(parsed.personas) ? parsed.personas : [],
					agentAccess: normalizeAgentAccess(parsed.agentAccess),
					agentToken: decryptKey({ geminiApiKeyEnc: parsed.agentTokenEnc, geminiApiKey: parsed.agentToken })
				}
			}
		} catch (error) {
			console.error('Failed to load settings:', error)
		}

		return {
			tempDir: this.defaultTempDir,
			modelSettings: DEFAULT_MODEL_SETTINGS
		}
	}

	private saveSettings(): boolean {
		try {
			if (!this.settingsPath) {
				console.error('Failed to save settings: settingsPath is unset (init() did not run)')
				return false
			}
			// The key is written encrypted under its own name and NEVER under the
			// plaintext one — otherwise an upgrade would leave the old copy behind
			// beside the new one.
			const { geminiApiKey, agentToken, ...rest } = this.settings
			const { enc, plain } = encryptKey(geminiApiKey ?? '')
			// The agent token follows the same rule: encrypted where the OS can.
			const token = encryptKey(agentToken ?? '')
			writeFileSync(this.settingsPath, JSON.stringify({
				...rest,
				...(enc ? { geminiApiKeyEnc: enc } : {}),
				...(plain ? { geminiApiKey: plain } : {}),
				...(token.enc ? { agentTokenEnc: token.enc } : {}),
				...(token.plain ? { agentToken: token.plain } : {})
			}, null, 2))
			return true
		} catch (error) {
			console.error('Failed to save settings:', error)
			return false
		}
	}

	getTempDir(): string {
		const dir = this.settings.tempDir
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
		return dir
	}

	isTempDirUnsafe(): boolean {
		try {
			const currentDir = this.getTempDir()
			const systemTemp = os.tmpdir()

			// On macOS, /var is often a symlink to /private/var.
			// Resolving both paths ensures accurate comparison.
			const resolvedCurrent = realpathSync(currentDir)
			const resolvedSystem = realpathSync(systemTemp)

			return resolvedCurrent.startsWith(resolvedSystem)
		} catch (error) {
			console.error('Failed to check if temp dir is unsafe:', error)
			// Fallback to simpler check if realpath fails
			return this.settings.tempDir.startsWith(os.tmpdir())
		}
	}

	/**
	 * Returns false if the new location could not be persisted — in which case
	 * the previous one is kept. Silently accepting it would leave the running app
	 * writing projects somewhere it forgets on restart.
	 */
	setTempDir(path: string): boolean {
		const previous = this.settings.tempDir
		this.settings.tempDir = path
		if (!this.saveSettings()) {
			this.settings.tempDir = previous
			return false
		}

		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true })
		}
		return true
	}

	resetTempDir(): string {
		this.settings.tempDir = this.defaultTempDir
		this.saveSettings()

		if (!existsSync(this.defaultTempDir)) {
			mkdirSync(this.defaultTempDir, { recursive: true })
		}

		return this.defaultTempDir
	}

	getThreadTempDir(threadId: string): string {
		const baseDir = this.getTempDir()
		const threadDir = join(baseDir, threadId)
		if (!existsSync(threadDir)) {
			mkdirSync(threadDir, { recursive: true })
		}
		return threadDir
	}

	getGeminiApiKey(): string | undefined {
		return this.settings.geminiApiKey
	}

	setGeminiApiKey(key: string): void {
		this.settings.geminiApiKey = key
		this.saveSettings()
	}

	/** Whether the key on disk is encrypted, so Settings can say which it is. */
	isKeyEncrypted(): boolean {
		try {
			return safeStorage.isEncryptionAvailable()
		} catch {
			return false
		}
	}

	getModelSettings(): ModelSettings {
		return this.settings.modelSettings || DEFAULT_MODEL_SETTINGS
	}

	setModelSettings(settings: ModelSettings): void {
		this.settings.modelSettings = this.mergeModelSettings(settings)
		this.saveSettings()
	}

	resetModelSettings(): ModelSettings {
		this.settings.modelSettings = DEFAULT_MODEL_SETTINGS
		this.saveSettings()
		return DEFAULT_MODEL_SETTINGS
	}

	/** User-defined personas only (built-ins live in constants/personas.ts). */
	getPersonas(): EditorPersona[] {
		return this.settings.personas || []
	}

	/**
	 * Persists user personas. Built-in entries and any entry whose id collides
	 * with a built-in are filtered out — built-ins are code, not data.
	 */
	setPersonas(personas: EditorPersona[]): EditorPersona[] {
		const builtinIds = new Set(BUILTIN_PERSONAS.map((p) => p.id))
		this.settings.personas = (personas || []).filter(
			(p) => !p.builtin && !builtinIds.has(p.id)
		)
		this.saveSettings()
		return this.settings.personas
	}

	// ===== Agent access (MCP) =====

	getAgentAccess(): AgentAccessSettings {
		return this.settings.agentAccess || normalizeAgentAccess(undefined)
	}

	updateAgentAccess(patch: Partial<AgentAccessSettings>): AgentAccessSettings {
		this.settings.agentAccess = normalizeAgentAccess({ ...this.getAgentAccess(), ...patch })
		this.saveSettings()
		return this.settings.agentAccess
	}

	/** Most recent first, capped. */
	recordAgentSession(entry: AgentRecentSession): void {
		const access = this.getAgentAccess()
		const recent = [entry, ...access.recent.filter((r) => r.startedAt !== entry.startedAt || r.clientName !== entry.clientName)]
		this.updateAgentAccess({ recent: recent.slice(0, RECENT_AGENT_SESSIONS) })
	}

	/** Generated on first use, per install. */
	getAgentToken(): string {
		if (!this.settings.agentToken) return this.newAgentToken()
		return this.settings.agentToken
	}

	newAgentToken(): string {
		this.settings.agentToken = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
		this.saveSettings()
		return this.settings.agentToken
	}
}

export const settingsManager = new SettingsManager()
