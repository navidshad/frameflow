import type { EditorRevision } from './types'

/**
 * Pure tree helpers for the editor's revision history, shared by the renderer
 * (list + graph rendering, subtree deletion) and main (cap pruning).
 *
 * No Electron / Node imports allowed here — main's revisions.ts imports `app`
 * from electron, so this is the only way the cap logic gets under test.
 */

/** Minimal shape these helpers need — lets tests use fixtures, not full snapshots. */
export interface RevisionNode {
	id: string
	parentId: string | null
	createdAt: number
}

/**
 * Group revisions by parent id, oldest first. The `null` key holds the roots
 * (normally exactly one, but a crash between push and pointer-write can leave two).
 */
export function childrenByParent<T extends RevisionNode>(revisions: readonly T[]): Map<string | null, T[]> {
	const map = new Map<string | null, T[]>()
	for (const rev of revisions) {
		const list = map.get(rev.parentId) || []
		list.push(rev)
		map.set(rev.parentId, list)
	}
	for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt)
	return map
}

/** Depth-first walk from the roots, carrying depth for the list's indentation. */
export function flattenTree<T extends RevisionNode>(
	revisions: readonly T[]
): { revision: T; depth: number }[] {
	const children = childrenByParent(revisions)
	const out: { revision: T; depth: number }[] = []
	const walk = (parentId: string | null, depth: number) => {
		for (const rev of children.get(parentId) || []) {
			out.push({ revision: rev, depth })
			walk(rev.id, depth + 1)
		}
	}
	walk(null, 0)
	return out
}

/** The given revision plus every descendant — what deleting a branch removes. */
export function collectSubtree<T extends RevisionNode>(
	revisions: readonly T[],
	id: string
): Set<string> {
	const children = childrenByParent(revisions)
	const ids = new Set<string>()
	const collect = (revId: string) => {
		if (ids.has(revId)) return // defensive: a cycle would otherwise hang
		ids.add(revId)
		for (const child of children.get(revId) || []) collect(child.id)
	}
	collect(id)
	return ids
}

/**
 * Does the history actually fork? Drives whether the revisions panel opens in
 * graph mode — a straight chain reads better as a list. Two roots counts: that
 * is also not a straight line, and the graph is what explains it.
 */
export function hasBranch<T extends RevisionNode>(revisions: readonly T[]): boolean {
	for (const list of childrenByParent(revisions).values()) {
		if (list.length > 1) return true
	}
	return false
}

/**
 * Which revisions to drop to get back under `max`, oldest LEAF first.
 *
 * Leaf-only pruning is what guarantees no survivor loses an ancestor. The root
 * and `keepId` (the revision just pushed) are never candidates. A pathological
 * pure chain has no eligible leaf, so it returns early and the caller is
 * expected to exceed the cap rather than corrupt the parent chain.
 */
export function pruneToCap<T extends RevisionNode>(
	revisions: readonly T[],
	keepId: string,
	max: number
): string[] {
	let remaining = [...revisions]
	const pruned: string[] = []

	while (remaining.length > max) {
		const hasChildren = new Set(remaining.map((r) => r.parentId).filter(Boolean))
		const candidate = remaining
			.filter((r) => r.parentId !== null && r.id !== keepId && !hasChildren.has(r.id))
			.sort((a, b) => a.createdAt - b.createdAt)[0]
		if (!candidate) break
		remaining = remaining.filter((r) => r.id !== candidate.id)
		pruned.push(candidate.id)
	}
	return pruned
}

/** Convenience for callers that want the surviving set rather than the removed ids. */
export function applyPrune<T extends RevisionNode>(revisions: readonly T[], prunedIds: readonly string[]): T[] {
	if (!prunedIds.length) return [...revisions]
	const drop = new Set(prunedIds)
	return revisions.filter((r) => !drop.has(r.id))
}

export type { EditorRevision }
