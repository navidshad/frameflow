import { BrowserWindow } from 'electron'
import { FileType, Thread, Message, EnrichedTimelineSegment, PipelineResultType } from '../../shared/types'

export type PipelineFunction = (data: any, context: PipelineContext) => Promise<void> | void;

import { threadManager } from '../threads'

export interface PipelineContext {
	updateStatus: (status: string) => Promise<void>;
	next: (data: any) => void;
	finish: (message: string, video?: { path: string; type: FileType.Preview | FileType.Actual }, timeline?: EnrichedTimelineSegment[], options?: { version?: number; shouldVersion?: boolean, resultType?: PipelineResultType, files?: Array<{ url: string, type: FileType }> }) => Promise<void>;
	fail: (error: string) => Promise<void>;
	savePreprocessing: (updates: Partial<Thread['preprocessing']>) => Promise<void>;
	recordUsage: (record: import('../../shared/types').UsageRecord) => Promise<void>;
	waitForTask: (taskId: string) => Promise<void>;
	signal: AbortSignal;
	threadId: string;
	videoPath: string;
	tempDir: string;
	preprocessing: Thread['preprocessing'];
	messageId: string;
	baseTimeline?: EnrichedTimelineSegment[]; // The timeline to based this generation on
	context: string;   // Full conversation history as text
	editRefId?: string; // ID of the message being edited/referenced
	intentResult?: import('../../shared/types').IntentResult;
	attachedImages?: string[];
	isThinkingMode?: boolean;
	autoUseImages?: boolean;
}

import { backgroundTaskManager } from '../tasks'

export class Pipeline {
	private steps: { fn: PipelineFunction; options?: { skipIf?: (context: PipelineContext) => boolean } }[] = []
	private currentStepIndex = 0
	private browserWindow: BrowserWindow
	private messageId: string
	private threadId: string
	private context: string
	private editRefId?: string
	private baseTimeline?: EnrichedTimelineSegment[]
	private intentResult?: import('../../shared/types').IntentResult
	private attachedImages?: string[]
	private isThinkingMode: boolean = false
	private autoUseImages: boolean = false
	private isFinished: boolean = false
	private abortController: AbortController = new AbortController()

	constructor(browserWindow: BrowserWindow, messageId: string, threadId: string, context: string, baseTimeline?: EnrichedTimelineSegment[], editRefId?: string, attachedImages?: string[], isThinkingMode: boolean = false, autoUseImages: boolean = false) {
		this.browserWindow = browserWindow
		this.messageId = messageId
		this.threadId = threadId
		this.context = context
		this.baseTimeline = baseTimeline
		this.editRefId = editRefId
		this.attachedImages = attachedImages
		this.isThinkingMode = isThinkingMode
		this.autoUseImages = autoUseImages
	}

	register(fn: PipelineFunction, options?: { skipIf?: (context: PipelineContext) => boolean }): this {
		this.steps.push({ fn, options });
		return this;
	}

	abort(): void {
		if (this.isFinished) {
			console.log(`[PIPELINE CORE] abort() skipped - already finished for message ${this.messageId}`)
			return
		}
		console.log(`[PIPELINE CORE] abort() TRIGGERED for message ${this.messageId}`)
		this.abortController.abort()
		
		// Immediately update UI to reflect stopped state
		this.fail('Processing stopped by user');
	}

	async start(initialData: any): Promise<void> {
		console.log(`[PIPELINE CORE] start() called. Total steps registered: ${this.steps.length}`)
		this.currentStepIndex = 0;
		let currentData = initialData;

		try {
			while (this.currentStepIndex < this.steps.length && !this.isFinished) {
				if (this.abortController.signal.aborted) {
					console.log(`[PIPELINE CORE] Pipeline aborted. Breaking loop.`)
					break
				}

				const thread = threadManager.getThread(this.threadId)
				if (!thread) {
					throw new Error(`Thread ${this.threadId} not found during pipeline execution`)
				}

				const step = this.steps[this.currentStepIndex];
				
				// Check skip condition
				const skipContext = this.createContext(currentData, thread);
				if (step.options?.skipIf && step.options.skipIf(skipContext)) {
					console.log(`[PIPELINE CORE] Skipping step index ${this.currentStepIndex}: ${step.fn.name || 'anonymous'}`)
					this.currentStepIndex++
					continue
				}

				console.log(`[PIPELINE CORE] Executing step index ${this.currentStepIndex}: ${step.fn.name || 'anonymous'}`)
				
				const prevIndex = this.currentStepIndex;
				let nextCalled = false;

				const context = this.createContext(currentData, thread);
				// Override next to capture data and advance index
				context.next = (data: any) => {
					currentData = data;
					this.currentStepIndex++;
					nextCalled = true;
					console.log(`[PIPELINE CONTEXT] next() called. Advancing to index ${this.currentStepIndex}`)
				};

				await step.fn(currentData, context);

				// If step finished without calling next, finish, or fail, it's an implicit stop or we should check state
				if (!nextCalled && !this.isFinished) {
					console.log(`[PIPELINE CORE] Step ${prevIndex} finished without calling next() or finish(). Stopping chain.`)
					break;
				}
			}
			console.log(`[PIPELINE CORE] Loop exited. isFinished=${this.isFinished}, aborted=${this.abortController.signal.aborted}`)
			
			// Final safety: if loop exited due to abort but wasn't marked finished, do it now
			if (!this.isFinished && this.abortController.signal.aborted) {
				await this.fail('Processing stopped by user');
			}
		} catch (e: any) {
			if (this.abortController.signal.aborted) {
				console.log(`[PIPELINE CORE] Caught expected abort error:`, e?.message)
			} else {
				console.error(`[PIPELINE CORE] Error in execution loop:`, e)
				await this.fail(e instanceof Error ? e.message : String(e))
			}
		}
	}

	private createContext(data: any, thread: Thread): PipelineContext {
		const self = this
		return {
			threadId: this.threadId,
			videoPath: thread.videoPath || '',
			tempDir: thread.tempDir,
			preprocessing: thread.preprocessing,
			messageId: this.messageId,
			context: this.context,
			editRefId: this.editRefId,
			baseTimeline: this.baseTimeline,
			attachedImages: this.attachedImages,
			isThinkingMode: this.isThinkingMode,
			autoUseImages: this.autoUseImages,
			get intentResult() { return self.intentResult },
			set intentResult(val) { self.intentResult = val },
			signal: this.abortController.signal,
			waitForTask: async (taskId: string) => {
				console.log(`[PIPELINE CONTEXT] waitForTask('${taskId}') called.`)
				await Promise.race([
					backgroundTaskManager.waitForTask(this.threadId, taskId),
					new Promise((_, reject) => {
						if (this.abortController.signal.aborted) {
							reject(new Error('Pipeline aborted'))
						}
						this.abortController.signal.addEventListener('abort', () => reject(new Error('Pipeline aborted')), { once: true })
					})
				]);
				console.log(`[PIPELINE CONTEXT] waitForTask('${taskId}') RESOLVED.`)
			},
			updateStatus: async (status: string) => {
				console.log(`[PIPELINE CONTEXT] updateStatus('${status}') called.`)
				this.browserWindow.webContents.send('pipeline-update', {
					id: this.messageId,
					type: 'status',
					content: status
				})
				if (this.threadId) {
					await threadManager.updateMessageInThread(this.threadId, this.messageId, {
						content: status,
						isPending: true
					})
				}
			},
			recordUsage: async (record: import('../../shared/types').UsageRecord) => {
				if (this.threadId) {
					await threadManager.updateMessageUsage(this.threadId, this.messageId, record)
					const updatedThread = threadManager.getThread(this.threadId)
					const updatedMessage = updatedThread?.messages.find(m => m.id === this.messageId)
					if (updatedMessage) {
						this.browserWindow.webContents.send('pipeline-update', {
							id: this.messageId,
							type: 'usage',
							usage: updatedMessage.usage,
							cost: updatedMessage.cost
						})
					}
				}
			},
			savePreprocessing: async (updates: Partial<Thread['preprocessing']>) => {
				console.log(`[PIPELINE CONTEXT] savePreprocessing() called.`)
				if (this.threadId) {
					const currentThread = threadManager.getThread(this.threadId)
					if (currentThread) {
						await threadManager.updateThread(this.threadId, {
							preprocessing: {
								...(currentThread.preprocessing || {}),
								...updates
							}
						})
					}
				}
			},
			next: (_nextData?: any) => {
				// This is a placeholder, will be overridden in the loop
			},
			finish: async (message: string, video?: { path: string; type: FileType.Preview | FileType.Actual }, timeline?: EnrichedTimelineSegment[], options?: { version?: number, shouldVersion?: boolean, resultType?: PipelineResultType, files?: Array<{ url: string, type: FileType }> }) => {
				return this.finish(message, video, timeline, options);
			},
			fail: async (error: string) => {
				return this.fail(error);
			}
		}
	}

	private async finish(message: string, video?: { path: string; type: FileType.Preview | FileType.Actual }, timeline?: EnrichedTimelineSegment[], options?: { version?: number, shouldVersion?: boolean, resultType?: PipelineResultType, files?: Array<{ url: string, type: FileType }> }) {
		console.log(`[PIPELINE CORE] finish() called.`)
		if (this.isFinished) return
		this.isFinished = true

		const updates: Partial<Message> = {
			content: message,
			files: options?.files || (video ? [{ url: video.path, type: video.type }] : []),
			timeline: timeline || [],
			resultType: options?.resultType,
			isPending: false
		}

		if (options?.shouldVersion !== false) {
			updates.version = options?.version || Date.now()
		}

		this.browserWindow.webContents.send('pipeline-update', {
			id: this.messageId,
			type: 'finish',
			content: message,
			files: updates.files,
			timeline: updates.timeline,
			resultType: updates.resultType,
			version: updates.version
		})

		if (this.threadId) {
			await threadManager.updateMessageInThread(this.threadId, this.messageId, updates)
		}
	}

	private async fail(error: string) {
		console.log(`[PIPELINE CORE] fail() called: ${error}`)
		if (this.isFinished) return
		this.isFinished = true

		const isAborted = this.abortController.signal.aborted
		const statusContent = isAborted ? 'Processing stopped by user' : `Error: ${error}`

		// Important: Send ONLY finish here to avoid race conditions in the renderer
		this.browserWindow.webContents.send('pipeline-update', {
			id: this.messageId,
			type: 'finish',
			content: statusContent
		})

		if (this.threadId) {
			await threadManager.updateMessageInThread(this.threadId, this.messageId, {
				content: statusContent,
				isPending: false
			})
		}
	}
}