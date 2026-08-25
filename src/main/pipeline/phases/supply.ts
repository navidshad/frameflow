import { PipelineFunction } from '../index'
import fs from 'fs'

export const supplyController: PipelineFunction = async (data, context) => {
	context.updateStatus('Managing reference images...')

	// Determine if we can use project images
	const isImageAccessEnabled = context.autoUseImages || (context.attachedImages && context.attachedImages.length > 0)

	// Case 1: User provided attachments
	if (context.attachedImages && context.attachedImages.length > 0) {
		console.log(`[SUPPLY] User provided ${context.attachedImages.length} attachments. Skipping auto-selection from video.`)
		const cleanedPaths = context.attachedImages.map(url => url.replace(/^media:\/+/i, '/'))
		context.next({ ...data, selectedReferenceImages: cleanedPaths })
		return
	}

	// Case 2: No attachments, handle auto-selection ONLY if image access is enabled
	if (!isImageAccessEnabled) {
		console.log('[SUPPLY] Image access disabled and no attachments. Providing empty image list.')
		context.next({ ...data, selectedReferenceImages: [] })
		return
	}

	// Case 2: No attachments — auto-select from the project's own material.
	//
	// One pool now: the user's source images plus any stills sampled from a
	// reference video. This used to branch on `imageTextPath !== undefined` to
	// tell image threads from video threads, but only image threads reach this
	// phase — determineImageIntent throws without imageTextPath, and nothing
	// else writes it.
	const referenceFrames = context.preprocessing?.['reference-frames'] || []
	const sourceImages = context.preprocessing?.['sourceImages'] || []
	const pool = [...sourceImages, ...referenceFrames]

	const intentResult = context.intentResult

	if (!pool.length) {
		console.log('[SUPPLY] No reference material available in project.')
		context.next({ ...data, selectedReferenceImages: [] })
		return
	}

	// Rule: if user wont provide frames, ai must select a few frames itself.
	const selectedIndices = intentResult?.selectedIndices || []
	
	if (selectedIndices.length > 0) {
		console.log(`[SUPPLY] AI selected ${selectedIndices.length} items for reference.`)
		const selectedPaths = selectedIndices
			.map(idx => pool[idx])
			.filter(p => p && fs.existsSync(p))
		console.log(`[SUPPLY] Resolved ${selectedPaths.length} images from pool of ${pool.length}.`)
		context.next({ ...data, selectedReferenceImages: selectedPaths })
		return
	}

	// Fallback: no indices — pick a few representative items.
	console.log(`[SUPPLY] No specific selection. Picking representative items from pool of ${pool.length}.`)
	const fallbackIndices = pool.length <= 5 
		? pool.map((_, i) => i)
		: [0, Math.floor(pool.length / 2), pool.length - 1]
	
	const fallbackPaths = fallbackIndices
		.map(i => pool[i])
		.filter(p => p && fs.existsSync(p))

	context.next({ ...data, selectedReferenceImages: fallbackPaths })
}
