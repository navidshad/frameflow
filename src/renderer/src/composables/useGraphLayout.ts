import { watch } from 'vue'
import { MessageRole } from '@shared/types'

export function useGraphLayout(videoStore: any, graphStore: any) {
  const syncGraph = () => {
    if (!videoStore.currentThreadId) return

    const messages = videoStore.messages
    const newNodes: any[] = []
    const newEdges: any[] = []

    // 1. Pre-process mapping
    const childMap: Record<string, string[]> = { 'root-media': [] }
    const messageLookup: Record<string, any> = {}

    messages.forEach(m => {
      messageLookup[m.id] = m
      const pId = m.editRefId || 'root-media'
      if (!childMap[pId]) childMap[pId] = []
      childMap[pId].push(m.id)
    })

    // Layout Constants
    const MIN_V_GAP = 150
    const H_SPACING = 600

    const strandGroups: Array<{ id: string, messageIds: string[], parentId: string, isResult: boolean }> = []
    const processedMessageIds = new Set<string>()

    /**
     * A "result" gets its own node; everything else joins a conversation strand.
     */
    const isResultMessage = (msg: any): boolean => {
      const hasRealFiles = msg.files && msg.files.filter((f: any) => f.type !== 'original').length > 0
      return !!(hasRealFiles || (msg.timeline && msg.timeline.length > 0))
    }

    // Recursive strand building
    const buildStrands = (pId: string) => {
      const children = childMap[pId] || []

      children.forEach((cId) => {
        if (processedMessageIds.has(cId)) return

        const msg = messageLookup[cId]

        if (isResultMessage(msg)) {
          // Results are always their own node
          strandGroups.push({ id: cId, messageIds: [cId], parentId: pId, isResult: true })
          processedMessageIds.add(cId)
          buildStrands(cId)
        } else {
          // It's a text message strand
          const strand: string[] = [cId]
          processedMessageIds.add(cId)

          let currentId = cId
          while (true) {
            const nextChildren = childMap[currentId] || []
            if (nextChildren.length !== 1) break

            const nextId = nextChildren[0]
            if (isResultMessage(messageLookup[nextId])) break

            strand.push(nextId)
            processedMessageIds.add(nextId)
            currentId = nextId
          }

          strandGroups.push({ id: strand[0], messageIds: strand, parentId: pId, isResult: false })
          buildStrands(currentId)
        }
      })
    }

    buildStrands('root-media')

    // 1.5 Create Message-to-Node mapping
    const msgToNodeId: Record<string, string> = { 'root-media': 'root-media' }
    strandGroups.forEach(strand => {
      strand.messageIds.forEach(mId => {
        msgToNodeId[mId] = strand.id
      })
    })

    // 2. Position Nodes
    const savedMetadata = videoStore.currentThread?.nodePositions || {}
    
    // Initialize from saved positions if available
    const nodePositions: Record<string, { x: number, y: number }> = {
      'root-media': savedMetadata['root-media'] || { x: 0, y: 0 }
    }

    // 2.1 Add Frame Nodes
    const frameIds = new Set<string>()
    Object.entries(savedMetadata).forEach(([id, meta]: [string, any]) => {
      if (meta.isFrame) {
        frameIds.add(id)
        const isLocked = !!meta.isLocked
        newNodes.push({
          id,
          type: 'frame',
          position: { x: meta.x, y: meta.y },
          draggable: !isLocked,
          selectable: true,
          data: {
            title: meta.title,
            width: meta.width || 400,
            height: meta.height || 300,
            isLocked,
            onUpdate: (fid: string, updates: any) => videoStore.updateNodeMetadata(fid, updates),
            onDelete: async () => {
              const result = await (window as any).api.showConfirmation({
                title: 'Delete Frame',
                message: 'Are you sure you want to delete this frame?',
                detail: 'Children nodes will be ungrouped but NOT deleted.',
                type: 'warning'
              })
              if (result.response === 1) {
                // We use the store method for deletion logic
                await videoStore.deleteFrame(id)
              }
            }
          }
        })
      }
    })

    // Root Media Node (Always branching).
    // Always image-collection: the graph only serves image projects now, and
    // ImageCollectionNode already shows a reference video as a chip when one
    // is attached. Video projects open in the timeline editor instead.
    newNodes.push({
      id: 'root-media',
      type: 'image-collection',
      position: nodePositions['root-media'],
      parentNode: frameIds.has(savedMetadata['root-media']?.parentNode) ? savedMetadata['root-media'].parentNode : undefined,
      data: {
        filename: videoStore.currentVideoName,
        videoPath: videoStore.currentVideoPath,
        showDetails: savedMetadata['root-media']?.showDetails || false,
        onSubmit: async (val: string, attachedImages?: string[], count?: number, isThinkingMode?: boolean, autoUseImages: boolean = false) => {
          const newMsgId = await videoStore.addMessage(val, MessageRole.User, undefined, attachedImages, autoUseImages)
          if (newMsgId && videoStore.currentThreadId) {
            await videoStore.startProcessing(videoStore.currentThreadId, newMsgId, count, isThinkingMode, autoUseImages)
          }
        }
      }
    })

    // Helper to estimate node height for layout calculations
    const getEstimatedHeight = (s: any) => {
      if (s.isResult) {
        const m = messageLookup[s.id]
        if (m?.isPending) return 200
        return 500 // Typical result node height
      }

      let h = 80 // Base header + padding
      s.messageIds.forEach((mId: string) => {
        const m = messageLookup[mId]
        const text = m.content || ""
        const lines = Math.max(1, Math.ceil(text.length / 45))
        h += (lines * 24) + 60
        if (m.files?.length) h += m.files.length * 160
      })
      const lastId = s.messageIds[s.messageIds.length - 1]
      const hasInput = (childMap[lastId] || []).length === 0
      if (hasInput) h += 100
      return h
    }

    const strandHeights: Record<string, number> = { 'root-media': 300 }

    // Layout strands
    strandGroups.forEach((strand) => {
      const parentNodeId = msgToNodeId[strand.parentId] || strand.parentId
      const parentPos = nodePositions[parentNodeId] || { x: 0, y: 0 }
      const parentHeight = strandHeights[parentNodeId] || 400

      // IF we have a saved position, USE IT. Otherwise calculate.
      if (videoStore.currentThread?.nodePositions?.[strand.id]) {
        nodePositions[strand.id] = videoStore.currentThread.nodePositions[strand.id]
      } else {
        const siblings = strandGroups.filter(s => s.parentId === strand.parentId)
        const index = siblings.indexOf(strand)

        let x = parentPos.x
        let y = parentPos.y

        if (strand.parentId === 'root-media') {
          // Media -> Horizontally offset branches
          x = parentPos.x + H_SPACING
          y = parentPos.y + (index * 600) // Keep horizontal branches separated vertically
        } else {
          // Sequential children vertical, branches horizontal
          if (index === 0) {
            y = parentPos.y + parentHeight + MIN_V_GAP
          } else {
            x = parentPos.x + (H_SPACING * index)
          }
        }
        nodePositions[strand.id] = { x, y }
      }

      // Store height for children positioning
      strandHeights[strand.id] = getEstimatedHeight(strand)

      if (strand.isResult) {
        const msg = messageLookup[strand.id]
        let nodeType = 'message'
        let data: any = { sender: msg.role, text: msg.content }

        if (msg.isPending) {
          nodeType = 'task'
          data = {
            type: 'processing',
            status: 'running',
            progress: null,
            steps: [{ name: msg.content || 'Processing...', status: 'active' }],
            onDelete: async () => {
              const result = await (window as any).api.showConfirmation({
                title: 'Delete Task Node',
                message: 'Are you sure you want to delete this running task and all its branches?',
                type: 'warning'
              })
              if (result.response === 1) {
                await videoStore.removeMessageBranch(strand.id)
              }
            },
            onStop: async () => {
              await videoStore.abortProcessing(strand.id)
            }
          }
        } else {
          const type = msg.resultType || ((msg.files && msg.files.length > 0) ? 'image' : 'summary')
          // Normalize nodeType to specialized components
          if (type === 'thumbnail' || type === 'generate-thumbnail' || type === 'image' || type === 'result-image') nodeType = 'thumbnail'
          else if (type === 'summary' || type === 'cover') nodeType = 'summary'
          else nodeType = 'summary' // Default fallback

          data = {
            id: msg.id,
            type,
            content: msg.content,
            files: msg.files,
            timeline: msg.timeline,
            version: msg.version,
            cost: msg.cost,
            showDetails: videoStore.currentThread?.nodePositions?.[strand.id]?.showDetails || false,
            onDelete: async () => {
              const result = await (window as any).api.showConfirmation({
                title: 'Delete Node',
                message: 'Are you sure you want to delete this result and all its branches?',
                type: 'warning'
              })
              if (result.response === 1) {
                await videoStore.removeMessageBranch(strand.id)
              }
            },
            onSubmit: async (val: string, attachedImages?: string[], count?: number, isThinkingMode?: boolean, autoUseImages: boolean = false) => {
              const newMsgId = await videoStore.addMessage(val, MessageRole.User, strand.id, attachedImages, autoUseImages)
              if (newMsgId && videoStore.currentThreadId) {
                await videoStore.startProcessing(videoStore.currentThreadId, newMsgId, count, isThinkingMode, autoUseImages)
              }
            }
          }
        }
        newNodes.push({ 
          id: strand.id, 
          type: nodeType, 
          position: nodePositions[strand.id], 
          parentNode: frameIds.has(savedMetadata[strand.id]?.parentNode) ? savedMetadata[strand.id].parentNode : undefined,
          data 
        })
      } else {
        // Conversation
        const lastId = strand.messageIds[strand.messageIds.length - 1]
        newNodes.push({
          id: strand.id,
          type: 'conversation',
          position: nodePositions[strand.id],
          parentNode: frameIds.has(savedMetadata[strand.id]?.parentNode) ? savedMetadata[strand.id].parentNode : undefined,
          data: {
            messages: strand.messageIds.map(id => messageLookup[id]),
            hasInputInitially: (childMap[lastId] || []).length === 0,
            width: videoStore.currentThread?.nodePositions?.[strand.id]?.width || 380,
            onDelete: async () => {
              const result = await (window as any).api.showConfirmation({
                title: 'Delete Node',
                message: 'Are you sure you want to delete this conversation and all its branches?',
                type: 'warning'
              })
              if (result.response === 1) {
                await videoStore.removeMessageBranch(strand.id)
              }
            },
            onSubmit: async (val: string, attachedImages?: string[], count?: number, isThinkingMode?: boolean, autoUseImages: boolean = false) => {
              const newMsgId = await videoStore.addMessage(val, MessageRole.User, lastId, attachedImages, autoUseImages)
              if (newMsgId && videoStore.currentThreadId) {
                await videoStore.startProcessing(videoStore.currentThreadId, newMsgId, count, isThinkingMode, autoUseImages)
              }
            }
          }
        })
      }

      newEdges.push({
        id: `e-${parentNodeId}-${strand.id}`,
        source: parentNodeId,
        target: strand.id,
        animated: strand.isResult && messageLookup[strand.id].isPending
      })
    })

    graphStore.setNodes(newNodes)
    graphStore.setEdges(newEdges)
  }

  // Setup watcher
  watch([() => videoStore.messages, () => videoStore.currentThread?.nodePositions], syncGraph, {
    deep: true,
    immediate: true
  })

  return { syncGraph }
}
