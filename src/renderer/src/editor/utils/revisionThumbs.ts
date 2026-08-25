import type { EditorDocument, EditorRevision, RevisionOrigin } from '@shared/types'

/**
 * Resolves up to `count` thumbnail URLs for a revision card by mapping the
 * snapshot's first timeline items back to their source clips' already-on-disk
 * scene JPGs (media://). Returns [] when nothing resolves — callers render a
 * placeholder block.
 */
export function revisionThumbs(revision: EditorRevision, doc: EditorDocument | null, count = 1): string[] {
	if (!doc) return []
	const items = [...revision.snapshot.timeline].sort((a, b) => a.timelineStart - b.timelineStart)
	const thumbs: string[] = []
	for (const item of items) {
		if (thumbs.length >= count) break
		const asset = doc.media.find((a) => a.id === item.sourceAssetId)
		const clip = asset?.clips.find((c) => c.id === item.sourceClipId)
		if (clip?.thumbnailPath) thumbs.push(`media://${clip.thumbnailPath}`)
	}
	return thumbs
}

export function relativeTime(timestamp: number): string {
	const delta = Date.now() - timestamp
	const minutes = Math.floor(delta / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

/**
 * Icon + tooltip for a revision's origin. Extracted because the list and the
 * graph rendered this mapping verbatim in two places, and only the list ever
 * had the tooltip.
 *
 * `ai` returns no icon — the caller supplies the persona's, which it looks up
 * from the store.
 */
export function originMeta(origin: RevisionOrigin): {
	icon: string | null
	iconClass: string
	title: string
} {
	switch (origin) {
		case 'ai':
			return { icon: null, iconClass: 'text-xs', title: 'AI edit' }
		case 'manual':
			return { icon: 'tabler--bookmark', iconClass: 'text-secondary', title: 'Manual checkpoint' }
		default:
			return { icon: 'tabler--flag', iconClass: 'text-zinc-400', title: 'Original' }
	}
}
