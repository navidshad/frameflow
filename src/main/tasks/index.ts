import { EventEmitter } from 'events'
import { BrowserWindow, ipcMain } from 'electron'
import { threadManager } from '../threads'
import { BackgroundTask, BackgroundTaskState, Thread } from '../../shared/types'
import { PipelineContext } from '../pipeline'
import * as extraction from '../pipeline/phases/extraction'
import * as imageExtraction from '../pipeline/phases/image-extraction'
import { enrichTranscriptWithScenes, SceneDescription } from '../timeline/enrichment'
import { TranscriptItem } from '../gemini/utils'
import * as ffmpegAdapter from '../ffmpeg'
import { THREAD_DIRS } from '../constants/paths'
import fs from 'fs'
import path from 'path'

class BackgroundTaskManager extends EventEmitter {
	private runningTasks = new Set<string>()

	constructor() {
		super()
	}

	public init() {
		ipcMain.handle('get-background-tasks', (_event, threadId) => {
			const thread = threadManager.getThread(threadId)
			return thread?.backgroundTasks || {}
		})
	}

	private getTaskKey(threadId: string, taskId: string) {
		return `${threadId}:${taskId}`
	}

	public async updateTask(threadId: string, taskId: string, updates: Partial<BackgroundTask>) {
		const thread = threadManager.getThread(threadId)
		if (!thread) return

		const tasks = thread.backgroundTasks || {}
		if (!tasks[taskId]) {
			tasks[taskId] = { id: taskId, name: taskId, state: 'pending' as BackgroundTaskState }
		}

		tasks[taskId] = { ...tasks[taskId], ...updates }
		await threadManager.updateThread(threadId, { backgroundTasks: tasks })

		// Emit IPC update to all windows
		BrowserWindow.getAllWindows().forEach(win => {
			win.webContents.send('background-task-update', {
				threadId,
				taskId,
				task: tasks[taskId]
			})
		})

		// internal event for waitForTask
		this.emit(`task-update:${threadId}:${taskId}`, tasks[taskId])
	}

	public async waitForTask(threadId: string, taskId: string): Promise<void> {
		console.log(`[TASK MANAGER] waitForTask('${taskId}') for thread ${threadId}`)
		const thread = threadManager.getThread(threadId)
		if (!thread) {
			console.log(`[TASK MANAGER] thread not found: ${threadId}`)
			return
		}

		const task = thread.backgroundTasks?.[taskId]
		console.log(`[TASK MANAGER] current task state for '${taskId}': ${task?.state || 'undefined'}`)

		if (task?.state === 'completed') {
			console.log(`[TASK MANAGER] task '${taskId}' already completed. Returning.`)
			return
		}
		if (task?.state === 'error') throw new Error(`Task ${taskId} failed: ${task.error}`)

		return new Promise((resolve, reject) => {
			console.log(`[TASK MANAGER] waiting for 'task-update:${threadId}:${taskId}' event...`)
			const listener = (updatedTask: BackgroundTask) => {
				console.log(`[TASK MANAGER] event received: 'task-update:${threadId}:${taskId}', new state: ${updatedTask.state}`)
				if (updatedTask.state === 'completed') {
					this.removeListener(`task-update:${threadId}:${taskId}`, listener)
					resolve()
				} else if (updatedTask.state === 'error') {
					this.removeListener(`task-update:${threadId}:${taskId}`, listener)
					reject(new Error(`Task ${taskId} failed: ${updatedTask.error}`))
				}
			}
			this.on(`task-update:${threadId}:${taskId}`, listener)
		})
	}

	private createMockContext(threadId: string, taskId: string): PipelineContext {
		const thread = threadManager.getThread(threadId)!
		let intentResult: any = undefined

		return {
			threadId,
			videoPath: thread.videoPath || '',
			tempDir: thread.tempDir,
			get preprocessing() {
				return threadManager.getThread(threadId)?.preprocessing || {}
			},
			messageId: 'bg-task',
			context: '', // not really used by preprocessing
			baseTimeline: undefined,
			get intentResult() { return intentResult },
			set intentResult(val) { intentResult = val },
			updateStatus: async (status: string) => {
				this.updateTask(threadId, taskId, { state: 'running', status })
				console.log(`[BG ${taskId}] ${status}`)
			},
			recordUsage: async (record) => {
				// We don't have a message to attach it to, but we can log it or add to thread totals if needed.
				console.log(`[BG ${taskId}] Usage: ${record.usage.totalTokens} tokens, Cost: $${record.cost}`)
			},
			savePreprocessing: async (updates) => {
				const currentThread = threadManager.getThread(threadId)
				if (currentThread) {
					await threadManager.updateThread(threadId, {
						preprocessing: {
							...(currentThread.preprocessing || {}),
							...updates
						}
					})
				}
			},
			waitForTask: async () => { },
			next: () => { },
			finish: async () => { },
			fail: async (error: string) => {
				console.error(`[BG ${taskId}] Task failed: ${error}`)
				this.updateTask(threadId, taskId, { state: 'error', error })
			},
			signal: new AbortController().signal
		}
	}

	private async runTask(threadId: string, taskId: string, name: string, fn: (context: PipelineContext) => Promise<void>) {
		const thread = threadManager.getThread(threadId)
		if (!thread) return

		// Initialize task if not present
		await this.updateTask(threadId, taskId, { name, state: 'pending', error: undefined })

		const taskKey = this.getTaskKey(threadId, taskId)
		if (this.runningTasks.has(taskKey)) return
		this.runningTasks.add(taskKey)

		try {
			await this.updateTask(threadId, taskId, { state: 'running' })
			const context = this.createMockContext(threadId, taskId)
			await fn(context)
			await this.updateTask(threadId, taskId, { state: 'completed' })
		} catch (error) {
			console.error(`Task ${taskId} failed:`, error)
			await this.updateTask(threadId, taskId, {
				state: 'error',
				error: error instanceof Error ? error.message : String(error)
			})
		} finally {
			this.runningTasks.delete(taskKey)
		}
	}

	public async startPreprocessing(threadId: string) {
		const thread = threadManager.getThread(threadId)
		if (!thread) return

		const run = this.runTask.bind(this, threadId)

		// Fire off independent chains
		// Chain 1: Downscale -> Audio -> Transcripts
		const processingChain = async () => {
			if (!thread.preprocessing.lowResVideoPath) {
				await run('downscale', 'Downscaling Video', async (ctx) => {
					await extraction.ensureLowResolution({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'downscale', { name: 'Downscaling Video', state: 'completed' })
			}

			if (!thread.preprocessing.audioPath) {
				await run('audio', 'Extracting Audio', async (ctx) => {
					await extraction.convertToAudio({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'audio', { name: 'Extracting Audio', state: 'completed' })
			}

			if (!thread.preprocessing.rawTranscriptPath) {
				await run('rawTranscript', 'Extracting Raw Transcript', async (ctx) => {
					await extraction.extractRawTranscript({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'rawTranscript', { name: 'Extracting Raw Transcript', state: 'completed' })
			}

			if (!thread.preprocessing.correctedTranscriptPath) {
				await run('correctedTranscript', 'Refining Transcript', async (ctx) => {
					await extraction.extractCorrectedTranscript({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'correctedTranscript', { name: 'Refining Transcript', state: 'completed' })
			}
		}

		// Chain 2: Scene Detection & Descriptions (depends on Downscale but we'll await downscale)
		const visualChain = async () => {
			await this.waitForTask(threadId, 'downscale').catch(() => { })

			if (!thread.preprocessing.sceneTimesPath) {
				await run('sceneTiming', 'Detecting Scenes', async (ctx) => {
					await extraction.extractSceneTiming({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'sceneTiming', { name: 'Detecting Scenes', state: 'completed' })
			}

			if (!thread.preprocessing.sceneDescriptionsPath) {
				await run('sceneDescriptions', 'Describing Scenes', async (ctx) => {
					await extraction.generateSceneDescription({}, ctx)
				})
			} else {
				await this.updateTask(threadId, 'sceneDescriptions', { name: 'Describing Scenes', state: 'completed' })
			}
		}

		// Start chains
		processingChain().catch(e => console.error(`[BACKGROUND] processingChain failed for ${threadId}:`, e))
		visualChain().catch(e => console.error(`[BACKGROUND] visualChain failed for ${threadId}:`, e))

		// Chain 3: Enrichment (Wait for BOTH)
		const enrichmentChain = async () => {
			// A dependency failure must not just abandon this chain. waitForTask
			// resolves off a task-update EVENT, so anything waiting on 'enrichment'
			// (generation.waitForEnrichTranscript) would wait on a record that is
			// now never created — a promise that never settles, and a
			// generate-timeline request that hangs with no error and no timeout.
			// Record the failure instead, so waiters reject.
			try {
				await Promise.all([
					this.waitForTask(threadId, 'correctedTranscript'),
					this.waitForTask(threadId, 'sceneDescriptions')
				])
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				console.error(`[BACKGROUND] enrichment dependencies failed for ${threadId}:`, message)
				await this.updateTask(threadId, 'enrichment', {
					name: 'Unifying Visuals & Text',
					state: 'error',
					error: `Cannot unify visuals and text: ${message}`
				})
				return
			}

			const currentThread = threadManager.getThread(threadId)
			if (!currentThread) return

			if (!currentThread.preprocessing.enrichedTranscriptPath) {
				await run('enrichment', 'Unifying Visuals & Text', async (ctx) => {
					const transcriptPath = ctx.preprocessing.correctedTranscriptPath || ctx.preprocessing.rawTranscriptPath
					const scenesPath = ctx.preprocessing.sceneDescriptionsPath

					if (transcriptPath && scenesPath && fs.existsSync(transcriptPath) && fs.existsSync(scenesPath)) {
						const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as TranscriptItem[]
						const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8')) as SceneDescription[]
						const duration = await ffmpegAdapter.getVideoDuration(ctx.videoPath)

						const enriched = enrichTranscriptWithScenes(transcript, scenes, duration)

						const enrichedPath = path.join(ctx.tempDir, 'enriched_transcript.json')
						fs.writeFileSync(enrichedPath, JSON.stringify(enriched, null, 2))

						await ctx.savePreprocessing({ enrichedTranscriptPath: enrichedPath })
					}
				})
			} else {
				await this.updateTask(threadId, 'enrichment', { name: 'Unifying Visuals & Text', state: 'completed' })
			}
		}

		enrichmentChain().catch(e => console.error(`[BACKGROUND] enrichmentChain failed for ${threadId}:`, e))
	}

	public async startImageProcessing(threadId: string) {
		const thread = threadManager.getThread(threadId)
		if (!thread) return

		const run = this.runTask.bind(this, threadId)

		// An image project may carry a video as REFERENCE material. Sample a few
		// frames from it first so extractImageData has them: that phase already
		// merges preprocessing['reference-frames'], and supply.ts already pools
		// them for auto-selection, so nothing downstream needs to change.
		if (thread.videoPath && !thread.preprocessing['reference-frames']?.length) {
			await run('referenceFrames', 'Sampling Reference Video', async (ctx) => {
				await this.extractReferenceFrames(ctx)
			})
		}

		// Task: Extract data from images
		if (!thread.preprocessing.imageTextPath) {
			await run('imageExtraction', 'Analyzing Images', async (ctx) => {
				await imageExtraction.extractImageData({}, ctx)
			})
		} else {
			await this.updateTask(threadId, 'imageExtraction', { name: 'Analyzing Images', state: 'completed' })
		}
	}

	/**
	 * Evenly spaced stills from a reference video, for image projects.
	 *
	 * Deliberately NOT startPreprocessing: that runs the whole transcript +
	 * scenedetect chain, costs Gemini calls, and needs scenedetect installed —
	 * none of which a reference video warrants.
	 */
	private async extractReferenceFrames(ctx: PipelineContext) {
		const videoPath = ctx.videoPath
		if (!videoPath || !fs.existsSync(videoPath)) return

		const duration = await ffmpegAdapter.getVideoDuration(videoPath)
		if (!duration || duration <= 0) return

		const framesDir = path.join(ctx.tempDir, THREAD_DIRS.FRAMES)
		if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true })

		const SAMPLE_COUNT = 8
		const frames: string[] = []
		for (let i = 0; i < SAMPLE_COUNT; i++) {
			// Midpoints of equal slices — never 0s (often black) or the exact end.
			const timestamp = (duration * (i + 0.5)) / SAMPLE_COUNT
			await ctx.updateStatus(`Sampling reference frames… ${i + 1}/${SAMPLE_COUNT}`)
			try {
				frames.push(await ffmpegAdapter.extractFrame(videoPath, timestamp, framesDir))
			} catch (e) {
				console.error(`[referenceFrames] frame at ${timestamp}s failed:`, e)
			}
		}

		if (frames.length) {
			await ctx.savePreprocessing({ 'reference-frames': frames })
		}
	}
}

export const backgroundTaskManager = new BackgroundTaskManager()
