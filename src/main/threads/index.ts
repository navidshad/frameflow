import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { MessageRole, FileType } from '@shared/types'
import type { EditorDocument, Message, Thread, Track, Usage, UsageRecord, VideoMetadata } from '@shared/types'
import { settingsManager } from '../settings'
import { getVideoMetadata } from '../ffmpeg'
import { THREAD_DIRS } from '../constants/paths'

// Re-export needed types for consumers (if any, though shared is better)
export { MessageRole, FileType }
export type { Message }


class ThreadManager {
	private threadsDir: string
	private updateQueues: Map<string, Promise<any>> = new Map()

	constructor() {
		this.threadsDir = ''
	}

	public init() {
		try {
			this.threadsDir = path.join(app.getPath('userData'), 'threads')
			this.ensureThreadsDir()
			console.log(`[ThreadManager] Initialized with threadsDir: ${this.threadsDir}`)
		} catch (error) {
			console.error('[ThreadManager] Failed to initialize:', error)
		}
	}

	private ensureThreadsDir() {
		if (!fs.existsSync(this.threadsDir)) {
			fs.mkdirSync(this.threadsDir, { recursive: true })
		}
	}

	private getThreadPath(threadId: string) {
		return path.join(this.threadsDir, `${threadId}.json`)
	}

	private saveThread(thread: Thread) {
		const threadPath = this.getThreadPath(thread.id)
		const jsonData = JSON.stringify(thread, null, 2)

		// Save to primary storage (userData)
		fs.writeFileSync(threadPath, jsonData)

		// Mirror to artifact folder (tempDir) if it exists
		if (thread.tempDir && fs.existsSync(thread.tempDir)) {
			const mirrorPath = path.join(thread.tempDir, 'thread.json')
			fs.writeFileSync(mirrorPath, jsonData)
		}
	}

	// Create a new thread
	async createThread(videoPath: string | undefined, videoName: string, imagePaths?: string[]): Promise<Thread> {
		const id = uuidv4()
		const tempDir = settingsManager.getThreadTempDir(id)
		const type = videoPath ? 'video' : 'image'
		
		let finalVideoPath = videoPath
		if (videoPath) {
			const systemTempDir = settingsManager.getTempDir()
			
			// Strict check: No directories allowed as video source
			if (fs.existsSync(videoPath) && fs.statSync(videoPath).isDirectory()) {
				throw new Error(`Invalid video source: "${videoPath}" is a directory. Please provide a valid video file.`)
			}

			if (videoPath.startsWith(systemTempDir)) {
				try {
					const videoDir = path.join(tempDir, THREAD_DIRS.VIDEO)
					if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true })
					
					// Sanitize the name for the filesystem
					const sanitizedName = videoName.replace(/[^\x00-\x7F]/g, '').replace(/[^a-zA-Z0-9.-]/g, '_').trim()
					const targetPath = path.join(videoDir, sanitizedName)
					
					fs.renameSync(videoPath, targetPath)
					finalVideoPath = targetPath
					
					// Cleanup empty source download folder
					const sourceDir = path.dirname(videoPath)
					if (sourceDir !== systemTempDir && fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length === 0) {
						fs.rmdirSync(sourceDir)
					}
				} catch (error) {
					console.error(`Failed to move video to thread directory:`, error)
					// Fallback to original path if move fails
				}
			}
		}

		const sourceImages: string[] = []
		if (imagePaths && imagePaths.length > 0) {
			const imagesDir = path.join(tempDir, THREAD_DIRS.IMAGES)
			if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true })
			
			for (const imgPath of imagePaths) {
				const destPath = path.join(imagesDir, path.basename(imgPath))
				fs.copyFileSync(imgPath, destPath)
				sourceImages.push(destPath)
			}
		}


		let videoMetadata: VideoMetadata | undefined
		if (finalVideoPath) {
			try {
				videoMetadata = await getVideoMetadata(finalVideoPath)
			} catch (error) {
				console.error(`Failed to extract metadata for ${finalVideoPath}:`, error)
			}
		}

		const thread: Thread = {
			id,
			title: videoName,
			type,
			videoPath: finalVideoPath,
			preprocessing: {
				sourceImages: sourceImages.length > 0 ? sourceImages : undefined
			},
			tempDir,
			messages: [],
			versionCounter: 0,
			videoMetadata,
			usageHistory: [],
			createdAt: Date.now(),
			updatedAt: Date.now()
		}

		this.saveThread(thread)
		return thread
	}

	// Create a new timeline-editor project thread.
	// Unlike createThread, no videoPath is required and NO preprocessing auto-starts —
	// media is imported per-asset inside the editor (see src/main/editor/).
	async createEditorThread(title: string): Promise<Thread> {
		const id = uuidv4()
		const tempDir = settingsManager.getThreadTempDir(id)

		const seedTrack = (kind: Track['kind'], name: string, order: number): Track => ({
			id: uuidv4(),
			kind,
			name,
			order,
			muted: false,
			locked: false,
			hidden: false,
			height: 64
		})

		const editor: EditorDocument = {
			schemaVersion: 1,
			media: [],
			tracks: [
				seedTrack('video', 'V1', 0),
				seedTrack('audio', 'A1', 1),
				seedTrack('overlay', 'OV', 2)
			],
			timeline: [],
			timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
			activePersonaId: '',
			turns: [],
			historyRef: { currentStepId: '', stepCount: 0 },
			selection: {}
		}

		const thread: Thread = {
			id,
			title,
			type: 'editor',
			preprocessing: {},
			tempDir,
			messages: [],
			versionCounter: 0,
			usageHistory: [],
			editor,
			createdAt: Date.now(),
			updatedAt: Date.now()
		}

		this.saveThread(thread)
		return thread
	}


	// Helper to normalize paths (handles symlinks like /var vs /private/var on macOS)
	private normalize(p: string | undefined): string | undefined {
		if (!p) return p
		try {
			if (fs.existsSync(p)) return fs.realpathSync(p)
		} catch (e) {
			// Fallback to absolute path if realpath fails
		}
		return path.resolve(p)
	}

	// Helper to repair paths in a thread if it was moved
	private repairThreadPaths(thread: Thread): Thread {
		const currentArtifactDir = settingsManager.getTempDir()
		const threadId = thread.id
		const expectedTempDir = path.join(currentArtifactDir, threadId)

		// Robust comparison using normalized paths
		const normalizedCurrent = this.normalize(thread.tempDir)
		const normalizedExpected = this.normalize(expectedTempDir)

		if (normalizedCurrent !== normalizedExpected) {
			if (fs.existsSync(expectedTempDir)) {
				console.log(`[ThreadManager] Repairing paths for thread ${threadId}: ${thread.tempDir} -> ${expectedTempDir}`)

				const oldRoot = thread.tempDir
				const newRoot = expectedTempDir

				const fixPath = (p: string | undefined) => {
					if (!p) return p
					if (p.startsWith(oldRoot)) {
						return p.replace(oldRoot, newRoot)
					}
					return p
				}

				// Update root tempDir
				thread.tempDir = newRoot

				// Update video path
				thread.videoPath = fixPath(thread.videoPath)

				// Update preprocessing paths
				if (thread.preprocessing) {
					thread.preprocessing.audioPath = fixPath(thread.preprocessing.audioPath)
					thread.preprocessing.lowResVideoPath = fixPath(thread.preprocessing.lowResVideoPath)
					thread.preprocessing.transcriptPath = fixPath(thread.preprocessing.transcriptPath)
					thread.preprocessing.sceneTimesPath = fixPath(thread.preprocessing.sceneTimesPath)
					thread.preprocessing.rawTranscriptPath = fixPath(thread.preprocessing.rawTranscriptPath)
					thread.preprocessing.sceneDescriptionsPath = fixPath(thread.preprocessing.sceneDescriptionsPath)
					thread.preprocessing.enrichedTranscriptPath = fixPath(thread.preprocessing.enrichedTranscriptPath)

					if (thread.preprocessing.sourceImages) {
						thread.preprocessing.sourceImages = thread.preprocessing.sourceImages.map(fixPath) as string[]
					}
				}

				// Update message file paths
				thread.messages = thread.messages.map(msg => {
					if (msg.files) {
						msg.files = msg.files.map(f => ({
							...f,
							url: fixPath(f.url) || ''
						}))
					}
					if (msg.attachedImages) {
						msg.attachedImages = msg.attachedImages.map(fixPath) as string[]
					}
					return msg
				})

				// Update editor document media paths (timeline editor threads)
				if (thread.editor?.media) {
					for (const asset of thread.editor.media) {
						asset.originalPath = fixPath(asset.originalPath) || asset.originalPath
						asset.proxyPath = fixPath(asset.proxyPath)
						if (asset.preprocessing) {
							for (const key of Object.keys(asset.preprocessing) as Array<keyof Thread['preprocessing']>) {
								const value = asset.preprocessing[key]
								if (typeof value === 'string') {
									(asset.preprocessing as any)[key] = fixPath(value)
								} else if (Array.isArray(value)) {
									(asset.preprocessing as any)[key] = value.map(fixPath)
								}
							}
						}
						for (const clip of asset.clips || []) {
							clip.thumbnailPath = fixPath(clip.thumbnailPath)
						}
						for (const entry of asset.filmstrip || []) {
							entry.thumbnailPath = fixPath(entry.thumbnailPath) || entry.thumbnailPath
						}
					}
				}

				// Save the repaired thread back to metadata and mirror it
				this.saveThread(thread)
			}
		}

		return thread
	}

	// Sync threads between userData and artifact directory
	syncWithArtifactDir() {
		this.ensureThreadsDir()
		const currentArtifactDir = settingsManager.getTempDir()

		if (!fs.existsSync(currentArtifactDir)) return

		const projectFolders = fs.readdirSync(currentArtifactDir).filter(f => {
			const fullPath = path.join(currentArtifactDir, f)
			return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'thread.json'))
		})

		for (const folder of projectFolders) {
			const metadataPath = this.getThreadPath(folder)
			const hasMetadata = fs.existsSync(metadataPath)

			if (!hasMetadata) {
				console.log(`[ThreadManager] Recovering project metadata for ${folder} from artifact directory...`)
				try {
					const mirrorPath = path.join(currentArtifactDir, folder, 'thread.json')
					const content = fs.readFileSync(mirrorPath, 'utf-8')
					const thread = JSON.parse(content) as Thread

					// Force path repair upon recovery to ensure it matches current setup
					const repairedThread = this.repairThreadPaths(thread)
					this.saveThread(repairedThread)
					console.log(`[ThreadManager] Successfully recovered project ${folder}`)
				} catch (error) {
					console.error(`[ThreadManager] Failed to recover project ${folder}:`, error)
				}
			} else {
				// Even if metadata exists, we trigger a repair check to be safe
				try {
					const content = fs.readFileSync(metadataPath, 'utf-8')
					const thread = JSON.parse(content) as Thread
					this.repairThreadPaths(thread)
				} catch (e) {
					// Ignore parse errors here, getAllThreads will handle them
				}
			}
		}
	}

	// Get all threads (for the list view)
	getAllThreads(): Thread[] {
		// First, sync with the artifact directory to recover any "lost" projects
		this.syncWithArtifactDir()

		this.ensureThreadsDir()
		const files = fs.readdirSync(this.threadsDir).filter(file => file.endsWith('.json'))
		const threads: Thread[] = []

		for (const file of files) {
			const filePath = path.join(this.threadsDir, file)
			try {
				const content = fs.readFileSync(filePath, 'utf-8')
				let thread = JSON.parse(content) as Thread

				// Try to repair paths if they seem broken/moved
				thread = this.repairThreadPaths(thread)
				
				// Migrate usage if needed
				if (this.migrateThreadUsage(thread)) {
					this.saveThread(thread)
				}
				
				// Mark as missing if artifacts directory is not found, but DO NOT DELETE metadata.
				// This allows the user to repair the path or recover files manually.
				thread.missing = !!(thread.tempDir && !fs.existsSync(thread.tempDir))
				
				threads.push(thread)
			} catch (error) {
				console.error(`Failed to parse thread file ${file}:`, error)
			}
		}

		// Sort by recently updated
		return threads.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	// Get a specific thread
	getThread(id: string): Thread | null {
		const filePath = this.getThreadPath(id)
		if (!fs.existsSync(filePath)) {
			return null
		}

		try {
			const content = fs.readFileSync(filePath, 'utf-8')
			const thread = JSON.parse(content) as Thread
			
			// Migrate usage if needed
			if (this.migrateThreadUsage(thread)) {
				this.saveThread(thread)
			}
			
			return thread
		} catch (error) {
			console.error(`Failed to read thread ${id}:`, error)
			return null
		}
	}

	// Update a thread atomically via a mutator that runs INSIDE the queued closure.
	// The mutator receives the freshest thread state and returns the partial update
	// (or null to skip). This makes concurrent read-modify-write patterns safe
	// (e.g. multiple assets patching thread.editor.media in parallel).
	updateThreadWith(id: string, mutator: (thread: Thread) => Partial<Thread> | null): Promise<Thread | null> {
		const existingQueue = this.updateQueues.get(id) || Promise.resolve()

		const nextUpdate = existingQueue.then(async () => {
			const thread = this.getThread(id)
			if (!thread) return null

			const updates = mutator(thread)
			if (!updates) return thread

			const updatedThread = {
				...thread,
				...updates,
				updatedAt: Date.now()
			}

			this.saveThread(updatedThread)

			// Broadcast update to all renderer windows
			BrowserWindow.getAllWindows().forEach(win => {
				win.webContents.send('thread-updated', updatedThread)
			})

			return updatedThread
		}).catch(err => {
			console.error(`Atomic update failed for thread ${id}:`, err)
			return null
		})

		this.updateQueues.set(id, nextUpdate)

		// Optional: clean up map if queue is idle (not strictly necessary for small number of threads)
		nextUpdate.finally(() => {
			if (this.updateQueues.get(id) === nextUpdate) {
				// Don't delete if another update was already queued
			}
		})

		return nextUpdate
	}

	// Update a thread atomically with a precomputed partial.
	updateThread(id: string, updates: Partial<Thread>): Promise<Thread | null> {
		return this.updateThreadWith(id, () => updates)
	}

	private deleteFile(filePath: string) {
		if (!filePath) return
		const cleanPath = filePath.replace('file://', '')
		if (fs.existsSync(cleanPath)) {
			try {
				fs.unlinkSync(cleanPath)
			} catch (error) {
				console.error(`Failed to delete file ${cleanPath}:`, error)
			}
		}
	}

	private deleteThreadArtifacts(thread: Thread) {
		// Delete preprocessing files
		if (thread.preprocessing) {
			this.deleteFile(thread.preprocessing.audioPath || '')
			this.deleteFile(thread.preprocessing.lowResVideoPath || '')
			this.deleteFile(thread.preprocessing.transcriptPath || '')
		}

		// Delete thread temp directory
		if (thread.tempDir && fs.existsSync(thread.tempDir)) {
			try {
				fs.rmSync(thread.tempDir, { recursive: true, force: true })
			} catch (error) {
				console.error(`Failed to delete thread temp dir ${thread.tempDir}:`, error)
			}
		}

		// Delete message files (excluding original)
		for (const msg of thread.messages) {
			if (msg.files) {
				for (const file of msg.files) {
					if (file.type !== FileType.Original) {
						this.deleteFile(file.url)
					}
				}
			}
		}
	}

	// Delete a thread and its file
	deleteThread(id: string): boolean {
		const thread = this.getThread(id)
		if (thread) {
			this.deleteThreadArtifacts(thread)
		}

		const filePath = this.getThreadPath(id)
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath)
			return true
		}
		return false
	}

	// NEW: Delete all threads
	deleteAllThreads(): boolean {
		try {
			const threads = this.getAllThreads()
			for (const thread of threads) {
				this.deleteThreadArtifacts(thread)
			}

			this.ensureThreadsDir()
			const files = fs.readdirSync(this.threadsDir)
			for (const file of files) {
				fs.unlinkSync(path.join(this.threadsDir, file))
			}
			return true
		} catch (error) {
			console.error('Failed to delete all threads:', error)
			return false
		}
	}

	// Helper to add a message to a thread
	async addMessageToThread(threadId: string, message: Omit<Message, 'id' | 'createdAt'>): Promise<Message | null> {
		const id = uuidv4()
		const createdAt = Date.now()
		const fullMessage: Message = {
			id,
			createdAt,
			...message
		}

		await this.updateThread(threadId, {
			messages: [...(this.getThread(threadId)?.messages || []), fullMessage]
		})

		return fullMessage
	}

	// Update specific message in a thread
	async updateMessageInThread(threadId: string, messageId: string, updates: Partial<Message>): Promise<boolean> {
		const result = await this.updateThread(threadId, {
			messages: (this.getThread(threadId)?.messages || []).map(m =>
				m.id === messageId ? { ...m, ...updates } : m
			)
		})
		return !!result
	}

	getNextVersion(threadId: string): number {
		const thread = this.getThread(threadId)
		if (!thread) return 0

		const nextVersion = (thread.versionCounter || 0) + 1
		this.updateThread(threadId, { versionCounter: nextVersion })
		return nextVersion
	}

	// Update usage and cost for a message
	async updateMessageUsage(threadId: string, messageId: string, record: UsageRecord): Promise<boolean> {
		const thread = this.getThread(threadId)
		if (!thread) return false

		const historyRecord: UsageRecord = {
			...record,
			timestamp: Date.now(),
			messageId
		}

		const result = await this.updateThread(threadId, {
			usageHistory: [...(thread.usageHistory || []), historyRecord],
			messages: (thread.messages || []).map(m => {
				if (m.id !== messageId) return m

				const newUsage: Usage = {
					promptTokens: (m.usage?.promptTokens || 0) + record.usage.promptTokens,
					candidatesTokens: (m.usage?.candidatesTokens || 0) + record.usage.candidatesTokens,
					thinkingTokens: (m.usage?.thinkingTokens || 0) + (record.usage.thinkingTokens || 0),
					totalTokens: (m.usage?.totalTokens || 0) + record.usage.totalTokens
				}

				return {
					...m,
					usage: newUsage,
					cost: (m.cost || 0) + record.cost
				}
			})
		})
		return !!result
	}

	async updateThreadNodePositions(threadId: string, positions: Record<string, { x: number; y: number; width?: number }>): Promise<boolean> {
		const result = await this.updateThread(threadId, {
			nodePositions: positions
		})
		return !!result
	}
	// Reset all pending messages to non-pending (e.g. on app startup or shutdown)
	resetPendingMessages(): void {
		const threads = this.getAllThreads()
		for (const thread of threads) {
			let hasChanges = false
			for (const msg of thread.messages) {
				if (msg.isPending) {
					msg.isPending = false
					msg.content += ' (Interrupted)'
					hasChanges = true
				}
			}

			if (hasChanges) {
				thread.updatedAt = Date.now()
				this.saveThread(thread)
			}
		}
	}
	// Get formatted context for AI (messages + timelines)
	getThreadContext(threadId: string): string {
		const thread = this.getThread(threadId)
		if (!thread) return ''

		return thread.messages.map(m => {
			let content = `${m.role.toUpperCase()}: ${m.content}`
			if (m.timeline && m.timeline.length > 0) {
				const timelineText = m.timeline.map(t => `[${t.start} - ${t.end}] ${t.text}`).join('\n')
				content += `\n(AI Generated Timeline):\n${timelineText}`
			}
			return content
		}).join('\n\n')
	}

	// Traverse the node tree backwards via editRefId as the parent link to form an isolated branch context
	getBranchContext(threadId: string, messageId?: string): { text: string, attachedImages: string[] } {
		const thread = this.getThread(threadId)
		if (!thread) return { text: '', attachedImages: [] }

		const standardize = (p: string) => {
			if (!p) return ''
			// 1. Remove protocols
			let clean = p.replace(/^(media|file):\/*|^(?!\/)/i, '/')
			// 2. Normalize slashes for the current OS
			clean = clean.replace(/[\/\\]+/g, path.sep)
			// 3. Absolute normalization (resolves . and ..)
			try {
				return path.normalize(clean)
			} catch {
				return clean
			}
		}

		if (!messageId) {
			const text = this.getThreadContext(threadId)
			// For full thread context, collect ALL attached images from ALL messages
			const attachedImages = Array.from(new Set(
				thread.messages
					.flatMap(m => m.attachedImages || [])
					.map(standardize)
					.filter(p => !!p)
			))
			return { text, attachedImages }
		}

		const branchMessages: Message[] = []
		let currentMsgId: string | undefined = messageId

		while (currentMsgId) {
			const msg = thread.messages.find(m => m.id === currentMsgId)
			if (!msg) break
			
			branchMessages.push(msg)
			currentMsgId = msg.editRefId
		}

		// Array is constructed backward (leaf to root), reverse it chronologically
		branchMessages.reverse()

		const text = branchMessages.map(m => {
			let content = `${m.role.toUpperCase()}: ${m.content}`
			if (m.timeline && m.timeline.length > 0) {
				const timelineText = m.timeline.map(t => `[${t.start} - ${t.end}] ${t.text}`).join('\n')
				content += `\n(AI Generated Timeline):\n${timelineText}`
			}
			return content
		}).join('\n\n')

		// Take attachedImages ONLY FROM THE LEAF MESSAGE for graph-node refinement accuracy
		const leafMsg = branchMessages[branchMessages.length - 1]
		const attachedImages = Array.from(new Set(
			(leafMsg?.attachedImages || [])
				.map(standardize)
				.filter(p => !!p)
		))

		return { text, attachedImages }
	}

	// Get the last user message in a thread
	getLatestUserMessage(threadId: string): Message | null {
		const thread = this.getThread(threadId)
		if (!thread) return null
		return [...thread.messages].reverse().find(m => m.role === MessageRole.User) || null
	}

	// Remove a message from a thread and all its descendants recursively
	async removeMessageBranchFromThread(threadId: string, messageId: string): Promise<boolean> {
		const thread = this.getThread(threadId)
		if (!thread) return false

		const toRemove = new Set<string>()
		const collect = (id: string) => {
			if (toRemove.has(id)) return
			toRemove.add(id)
			const children = thread.messages.filter(m => m.editRefId === id)
			children.forEach(c => collect(c.id))
		}

		collect(messageId)

		// Delete associated files for all messages in the branch (except original and protected reference/analysis files)
		for (const id of toRemove) {
			const msg = thread.messages.find(m => m.id === id)
			if (msg && msg.files) {
				for (const file of msg.files) {
					if (file.type !== FileType.Original) {
						const cleanPath = file.url.replace('file://', '').replace('media://', '')
						
						// Only allow deletion if it belongs to generated directories
						const isGenerated = cleanPath.includes(`/${THREAD_DIRS.GENERATED_IMAGES}/`) || 
						                    cleanPath.includes(`/${THREAD_DIRS.GENERATED_VIDEOS}/`)
						
						if (isGenerated) {
							this.deleteFile(file.url)
						} else {
							console.log(`[ThreadManager] Skipping deletion of reference/analysis file during node removal: ${cleanPath}`)
						}
					}
				}
			}
		}

		const result = await this.updateThread(threadId, {
			messages: thread.messages.filter(m => !toRemove.has(m.id))
		})

		return !!result
	}

	// NEW: Remove a single message from a thread and re-chain its children
	async removeSingleMessage(threadId: string, messageId: string): Promise<boolean> {
		const thread = this.getThread(threadId)
		if (!thread) return false

		const msg = thread.messages.find(m => m.id === messageId)
		if (!msg) return false

		// 1. Delete associated files for THIS message only (except original and protected reference/analysis files)
		if (msg.files) {
			for (const file of msg.files) {
				if (file.type !== FileType.Original) {
					const cleanPath = file.url.replace('file://', '').replace('media://', '')
					
					// Only allow deletion if it belongs to generated directories
					const isGenerated = cleanPath.includes(`/${THREAD_DIRS.GENERATED_IMAGES}/`) || 
										cleanPath.includes(`/${THREAD_DIRS.GENERATED_VIDEOS}/`)
					
					if (isGenerated) {
						this.deleteFile(file.url)
					}
				}
			}
		}

		// 2. Re-chain children to point to this message's parent (editRefId)
		const parentId = msg.editRefId
		const updatedMessages = thread.messages
			.filter(m => m.id !== messageId)
			.map(m => m.editRefId === messageId ? { ...m, editRefId: parentId } : m)

		const result = await this.updateThread(threadId, {
			messages: updatedMessages
		})

		return !!result
	}

	async toggleThreadReferenceFrame(threadId: string, filePath: string): Promise<boolean> {
		const thread = this.getThread(threadId)
		if (!thread) return false

		const currentRefs = thread.preprocessing?.['reference-frames'] || []
		const index = currentRefs.indexOf(filePath)
		
		let newRefs: string[]
		if (index === -1) {
			newRefs = [...currentRefs, filePath]
		} else {
			newRefs = currentRefs.filter(r => r !== filePath)
		}

		const result = await this.updateThread(threadId, {
			preprocessing: {
				...(thread.preprocessing || {}),
				'reference-frames': newRefs
			}
		})

		return !!result
	}

	// Migrate usage from messages to usageHistory if history is empty
	private migrateThreadUsage(thread: Thread): boolean {
		// If usageHistory already has data, no migration needed
		if (thread.usageHistory && thread.usageHistory.length > 0) return false

		const history: UsageRecord[] = []
		for (const msg of thread.messages) {
			if (msg.usage && msg.cost && msg.cost > 0) {
				history.push({
					usage: msg.usage,
					cost: msg.cost,
					timestamp: msg.createdAt,
					messageId: msg.id
				})
			}
		}

		// Only migrate if we found usage or if usageHistory is missing (to initialize it)
		if (history.length > 0 || thread.usageHistory === undefined) {
			thread.usageHistory = history
			return true
		}

		return false
	}
}

export const threadManager = new ThreadManager()
