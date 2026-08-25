import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { MessageRole, FileType } from '@shared/types'
import type { Message, Thread, ThreadType } from '@shared/types'


export const useVideoStore = defineStore('video', () => {
	const threads = ref<Thread[]>([])
	const currentThreadId = ref<string | null>(null)

	const currentThread = computed(() =>
		threads.value.find((t: Thread) => t.id === currentThreadId.value) || null
	)

	const messages = computed(() => {
		if (!currentThread.value) return []
		const msgs = [...currentThread.value.messages]

		// Inject the original video into the first message if it's a user message and has no files
		if (msgs.length > 0 && msgs[0].role === MessageRole.User && (!msgs[0].files || msgs[0].files.length === 0) && currentThread.value.videoPath) {
			msgs[0] = {
				...msgs[0],
				files: [{ url: currentThread.value.videoPath, type: FileType.Original }]
			}
		}

		return msgs
	})

	const backgroundTasks = computed(() => {
		return currentThread.value?.backgroundTasks || {}
	})

	const activeBackgroundTasks = computed(() => {
		return Object.values(backgroundTasks.value).filter(t => t.state === 'running' || t.state === 'pending' || t.state === 'error')
	})

	const isBackgroundProcessingActive = computed(() => activeBackgroundTasks.value.length > 0)

	const currentVideoName = computed(() => currentThread.value?.title || '')
	const currentVideoPath = computed(() => currentThread.value?.videoPath || '')

	const fetchThreads = async () => {
		threads.value = await (window as any).api.getAllThreads()
	}

	/**
	 * Returns the whole thread, not just its id: the Home composer needs
	 * preprocessing.sourceImages (the COPIED paths) to attach to the first turn.
	 */
	const createThread = async (
		videoPath: string | undefined,
		videoName: string,
		imagePaths?: string[],
		type?: ThreadType
	): Promise<Thread> => {
		const payload = { videoPath, videoName, imagePaths, type }
		const newThread = await (window as any).api.createThread(JSON.parse(JSON.stringify(payload)))
		threads.value.unshift(newThread)
		currentThreadId.value = newThread.id
		return newThread
	}

	const selectThread = async (id: string) => {
		const thread = await (window as any).api.getThread(id)
		if (thread) {
			const index = threads.value.findIndex((t: Thread) => t.id === id)
			if (index !== -1) {
				threads.value[index] = thread
			} else {
				threads.value.unshift(thread)
			}
			currentThreadId.value = id
			if ((window as any).api) {
				const tasks = await (window as any).api.getBackgroundTasks(id)
				if (currentThread.value) {
					currentThread.value.backgroundTasks = tasks
				}
			}
		}
	}

	const addMessage = async (content: string, role: MessageRole, editRefId?: string, attachedImages?: string[], autoUseImages: boolean = false) => {
		if (!currentThreadId.value) return
		const message = {
			role,
			content,
			editRefId,
			attachedImages,
			autoUseImages,
			isPending: role === 'ai'
		}

		// Ensure the message is a plain object to avoid cloning issues with Vue Proxies over IPC
		const plainMessage = JSON.parse(JSON.stringify(message))
		const newMessage = await (window as any).api.addMessage(currentThreadId.value, plainMessage)

		// Update local state
		if (currentThread.value) {
			currentThread.value.messages.push(newMessage)
		}

		return newMessage.id
	}

	const clearMessages = () => {
		// Not used in thread mode, but kept for compatibility or cleanup
	}

	// Used when pipeline updates status
	const updateMessage = (id: string, partial: Partial<Omit<Message, 'id'>>) => {
		if (!currentThread.value) return

		const index = currentThread.value.messages.findIndex((m) => m.id === id)
		if (index !== -1) {
			currentThread.value.messages[index] = {
				...currentThread.value.messages[index],
				...partial
			}
		}
	}

	const updateNodePositions = async (positions: Record<string, { x: number; y: number }>) => {
		if (!currentThreadId.value || !currentThread.value) return
		
		const currentPositions = JSON.parse(JSON.stringify(currentThread.value.nodePositions || {}))
		
		for (const [id, pos] of Object.entries(positions)) {
			currentPositions[id] = {
				...(currentPositions[id] || {}),
				...JSON.parse(JSON.stringify(pos))
			}
		}
		
		try {
			const success = await (window as any).api.saveNodePositions(
				String(currentThreadId.value), 
				currentPositions
			)
			if (success && currentThread.value) {
				currentThread.value.nodePositions = currentPositions
			}
		} catch (error) {
			console.error('[videoStore] Failed to save node positions:', error)
		}
	}

	const startProcessing = async (threadId: string, editReferenceMessageId?: string, count: number = 1, isThinkingMode: boolean = false, autoUseImages: boolean = false) => {
		;(window as any).api.debugLog('startProcessing initiated', { threadId, editReferenceMessageId, count, isThinkingMode, autoUseImages })
		if (!threadId) {
			;(window as any).api.debugLog('startProcessing ABORTED: !threadId')
			return
		}
		if (!currentThread.value) {
			;(window as any).api.debugLog('startProcessing ABORTED: !currentThread.value')
			return
		}

		for (let i = 0; i < count; i++) {
			// Add initial AI status message
			;(window as any).api.debugLog(`startProcessing adding AI Message ${i + 1}/${count}...`)
			const newAiMessageId = await addMessage('Initializing pipeline...', MessageRole.AI, editReferenceMessageId, undefined, autoUseImages);
			;(window as any).api.debugLog('startProcessing AI Message Pushed! ID:', newAiMessageId)

			if ((window as any).api) {
				// Setup listener
				const cleanup = (window as any).api.onPipelineUpdate((data: any) => {
					if (data.id === newAiMessageId || data.messageId === newAiMessageId) {
						if (data.type === 'status' || data.status) {
							// Only update status if the message is still pending
							const msg = currentThread.value?.messages.find(m => m.id === newAiMessageId)
							if (msg && msg.isPending) {
								updateMessage(newAiMessageId, { content: data.status || data.content, isPending: true })
							}
						} else if (data.type === 'finish') {
							updateMessage(newAiMessageId, {
								content: data.content,
								isPending: false,
								files: data.files || (data.video ? [{ url: data.video.path, type: data.video.type }] : []),
								timeline: data.timeline,
								version: data.version,
								resultType: data.resultType
							})
							cleanup() // Remove listener when done
						} else if (data.type === 'usage') {
							updateMessage(newAiMessageId, {
								usage: data.usage,
								cost: data.cost
							})
						}
					}
				})

				;(window as any).api.debugLog('startProcessing dispatching startPipeline IPC...')
				try {
					await (window as any).api.startPipeline({
						threadId,
						newAiMessageId,
						isThinkingMode,
						autoUseImages
					})
					;(window as any).api.debugLog('startProcessing startPipeline IPC completed.')
				} catch (e) {
					;(window as any).api.debugLog('startProcessing startPipeline IPC FAILED:', e)
				}
			} else {
				console.error('API not found attached to window.')
			}
		}
	}

	const abortProcessing = async (messageId: string) => {
		if ((window as any).api) {
			await (window as any).api.abortPipeline(messageId)
		}
	}

	const retryPreprocessing = async (threadId: string) => {
		return await (window as any).api.retryPreprocessing(threadId)
	}

	// Setup global listener for background tasks
	if (typeof window !== 'undefined' && (window as any).api) {
		(window as any).api.onBackgroundTaskUpdate((data: { threadId: string, taskId: string, task: import('@shared/types').BackgroundTask }) => {
			const thread = threads.value.find(t => t.id === data.threadId)
			if (thread) {
				thread.backgroundTasks = {
					...(thread.backgroundTasks || {}),
					[data.taskId]: data.task
				}
			}
		});

		(window as any).api.onThreadUpdated((updatedThread: Thread) => {
			// Find the local thread and update it
			const index = threads.value.findIndex(t => t.id === updatedThread.id)
			if (index !== -1) {
				// We merge some properties to avoid losing local-only state if any
				// but since Thread is the source of truth, replacing is mostly fine.
				threads.value[index] = {
					...threads.value[index],
					...updatedThread
				}
			} else {
				// If it's a new thread (e.g. from another window), add it
				threads.value.unshift(updatedThread)
			}
		});
	}

	const deleteThread = async (id: string) => {
		const success = await (window as any).api.deleteThread(id)
		if (success) {
			threads.value = threads.value.filter((t: Thread) => t.id !== id)
			if (currentThreadId.value === id) {
				currentThreadId.value = null
			}
		}
		return success
	}

	const deleteAllThreads = async () => {
		const success = await (window as any).api.deleteAllThreads()
		if (success) {
			threads.value = []
			currentThreadId.value = null
		}
		return success
	}
	const removeMessageBranch = async (messageId: string) => {
		if (!currentThreadId.value || !currentThread.value) return
		const success = await (window as any).api.removeMessage(currentThreadId.value, messageId)
		if (success && currentThread.value) {
			const toRemove = new Set<string>()
			const collect = (id: string) => {
				toRemove.add(id)
				const children = currentThread.value!.messages.filter(m => m.editRefId === id)
				children.forEach(c => collect(c.id))
			}
			collect(messageId)
			currentThread.value.messages = currentThread.value.messages.filter((m) => !toRemove.has(m.id))
		}
		return success
	}

	const removeSingleMessage = async (messageId: string) => {
		if (!currentThreadId.value || !currentThread.value) return
		const success = await (window as any).api.removeSingleMessage(currentThreadId.value, messageId)
		if (success && currentThread.value) {
			const msg = currentThread.value.messages.find(m => m.id === messageId)
			if (msg) {
				const parentId = msg.editRefId
				currentThread.value.messages = currentThread.value.messages
					.filter((m) => m.id !== messageId)
					.map(m => m.editRefId === messageId ? { ...m, editRefId: parentId } : m)
			}
		}
		return success
	}

	const updateMessageContent = async (messageId: string, content: string) => {
		if (!currentThreadId.value || !currentThread.value) return
		const success = await (window as any).api.updateMessage(currentThreadId.value, messageId, { content })
		if (success && currentThread.value) {
			const index = currentThread.value.messages.findIndex(m => m.id === messageId)
			if (index !== -1) {
				currentThread.value.messages[index].content = content
			}
		}
		return success
	}

	const updateNodeMetadata = async (nodeId: string, metadata: Partial<NonNullable<Thread['nodePositions']>[string]>) => {
		if (!currentThreadId.value || !currentThread.value) return
		
		const currentPositions = JSON.parse(JSON.stringify(currentThread.value.nodePositions || {}))
		const existing = currentPositions[nodeId] || { x: 0, y: 0 }
		
		const updatedPositions = {
			...currentPositions,
			[nodeId]: {
				...existing,
				...JSON.parse(JSON.stringify(metadata))
			}
		}
		
		try {
			const success = await (window as any).api.saveNodePositions(
				String(currentThreadId.value), 
				JSON.parse(JSON.stringify(updatedPositions))
			)
			if (success && currentThread.value) {
				currentThread.value.nodePositions = updatedPositions
			}
			return success
		} catch (error) {
			console.error('[videoStore] Failed to save node positions:', error)
			return false
		}
	}

	const retryMessage = async (messageId: string, shouldRemoveBranch: boolean = true, count: number = 1, isThinkingMode: boolean = false, autoUseImages?: boolean) => {
		if (!currentThreadId.value || !currentThread.value) return

		const index = currentThread.value.messages.findIndex(m => m.id === messageId)
		if (index === -1) return

		const message = currentThread.value.messages[index]
		if (message.role !== MessageRole.User) return

		// Update the setting if provided, otherwise preserve original
		if (autoUseImages !== undefined) {
			message.autoUseImages = autoUseImages
			// Persist the change to disk
			await (window as any).api.updateMessage(currentThreadId.value, messageId, { autoUseImages })
		}

		if (shouldRemoveBranch) {
			// Remove any messages that branch from this one
			const children = currentThread.value.messages.filter(m => m.editRefId === messageId)
			for (const child of children) {
				await removeMessageBranch(child.id)
			}
		}

		// Re-trigger processing attaching to the user message
		await startProcessing(currentThreadId.value, message.id, count, isThinkingMode, message.autoUseImages)
	}

	const deleteFrame = async (frameId: string) => {
		if (!currentThreadId.value || !currentThread.value) return
		
		const currentPositions = JSON.parse(JSON.stringify(currentThread.value.nodePositions || {}))
		const frameMeta = currentPositions[frameId]
		if (!frameMeta) return

		// Ungroup children using database-only math for 100% reliability
		Object.entries(currentPositions).forEach(([id, meta]: [string, any]) => {
			if (meta.parentNode === frameId) {
				// Absolute = Frame (Absolute) + Child (Relative)
				const absoluteX = (frameMeta.x || 0) + (meta.x || 0)
				const absoluteY = (frameMeta.y || 0) + (meta.y || 0)
				
				currentPositions[id] = { 
					...meta, 
					x: absoluteX, 
					y: absoluteY, 
					parentNode: null 
				}
			}
		})

		delete currentPositions[frameId]

		try {
			const success = await (window as any).api.saveNodePositions(
				String(currentThreadId.value), 
				currentPositions
			)
			if (success && currentThread.value) {
				currentThread.value.nodePositions = currentPositions
			}
			return success
		} catch (error) {
			console.error('[videoStore] Failed to delete frame:', error)
			return false
		}
	}

	const toggleReferenceFrame = async (filePath: string) => {
		if (!currentThreadId.value) return false
		const success = await (window as any).api.toggleReferenceFrame(currentThreadId.value, filePath)
		return success
	}

	const improviseMessage = async (messageId: string) => {
		if (!currentThreadId.value) return null
		try {
			return await (window as any).api.improviseMessage(currentThreadId.value, messageId)
		} catch (error) {
			console.error('[videoStore] Failed to improvise message:', error)
			return null
		}
	}

	return {
		threads,
		currentThreadId,
		currentThread,
		messages,
		backgroundTasks,
		activeBackgroundTasks,
		isBackgroundProcessingActive,
		currentVideoName,
		currentVideoPath,

		fetchThreads,
		createThread,
		selectThread,
		addMessage,
		clearMessages,
		startProcessing,
		abortProcessing,
		deleteThread,
		deleteAllThreads,
		removeMessageBranch,
		removeSingleMessage,
		retryMessage,
		updateMessage,
		updateMessageContent,
		updateNodePositions,
		updateNodeMetadata,
		deleteFrame,
		retryPreprocessing,
		toggleReferenceFrame,
		improviseMessage
	}
})