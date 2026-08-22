import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import os from 'os'
import { EditorPersona, ModelSettings } from '../shared/types'
import { DEFAULT_MODEL_SETTINGS } from './constants/gemini'
import { BUILTIN_PERSONAS } from './constants/personas'

interface Settings {
	tempDir: string
	geminiApiKey?: string
	modelSettings?: ModelSettings
	/** User-defined editor personas ONLY — built-ins are merged at read time. */
	personas?: EditorPersona[]
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
					geminiApiKey: parsed.geminiApiKey,
					modelSettings: this.mergeModelSettings(parsed.modelSettings || DEFAULT_MODEL_SETTINGS),
					personas: Array.isArray(parsed.personas) ? parsed.personas : []
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
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2))
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
}

export const settingsManager = new SettingsManager()
