import { describe, expect, it } from 'vitest'
import {
	applyPrune,
	childrenByParent,
	collectSubtree,
	flattenTree,
	hasBranch,
	pruneToCap,
	type RevisionNode
} from './revision-tree'

/** `rev('b', 'a', 2)` = node b, child of a, created at t=2. */
const rev = (id: string, parentId: string | null, createdAt: number): RevisionNode =>
	({ id, parentId, createdAt })

/** root -> a -> b -> c, a straight chain. */
const chain = [rev('root', null, 0), rev('a', 'root', 1), rev('b', 'a', 2), rev('c', 'b', 3)]

/**
 *        root
 *        /  \
 *       a    x
 *      / \
 *     b   y
 */
const forked = [
	rev('root', null, 0),
	rev('a', 'root', 1),
	rev('b', 'a', 2),
	rev('x', 'root', 3),
	rev('y', 'a', 4)
]

describe('childrenByParent', () => {
	it('groups by parent with the roots under the null key', () => {
		const map = childrenByParent(forked)
		expect(map.get(null)!.map((r) => r.id)).toEqual(['root'])
		expect(map.get('root')!.map((r) => r.id)).toEqual(['a', 'x'])
		expect(map.get('a')!.map((r) => r.id)).toEqual(['b', 'y'])
	})

	it('sorts each sibling list oldest first regardless of input order', () => {
		const shuffled = [rev('c', 'p', 30), rev('a', 'p', 10), rev('b', 'p', 20)]
		expect(childrenByParent(shuffled).get('p')!.map((r) => r.id)).toEqual(['a', 'b', 'c'])
	})

	it('returns an empty map for no revisions', () => {
		expect(childrenByParent([]).size).toBe(0)
	})
})

describe('flattenTree', () => {
	it('walks depth-first with increasing depth down a chain', () => {
		expect(flattenTree(chain).map((e) => [e.revision.id, e.depth]))
			.toEqual([['root', 0], ['a', 1], ['b', 2], ['c', 3]])
	})

	it('finishes a branch before starting its sibling', () => {
		// a's subtree (b, y) must come out before x
		expect(flattenTree(forked).map((e) => e.revision.id))
			.toEqual(['root', 'a', 'b', 'y', 'x'])
	})

	it('emits every root when there is more than one', () => {
		const twoRoots = [rev('r1', null, 0), rev('r2', null, 1), rev('k', 'r1', 2)]
		expect(flattenTree(twoRoots).map((e) => [e.revision.id, e.depth]))
			.toEqual([['r1', 0], ['k', 1], ['r2', 0]])
	})
})

describe('collectSubtree', () => {
	it('includes the node itself and every descendant', () => {
		expect([...collectSubtree(forked, 'a')].sort()).toEqual(['a', 'b', 'y'])
	})

	it('is just the node for a leaf', () => {
		expect([...collectSubtree(forked, 'b')]).toEqual(['b'])
	})

	it('is everything when called on the root', () => {
		expect(collectSubtree(forked, 'root').size).toBe(5)
	})

	it('does not hang on a cycle', () => {
		// Not reachable through the app, but a corrupt sidecar should not lock the UI.
		const cyclic = [rev('p', 'q', 0), rev('q', 'p', 1)]
		expect([...collectSubtree(cyclic, 'p')].sort()).toEqual(['p', 'q'])
	})
})

describe('hasBranch', () => {
	it('is false for a straight chain', () => {
		expect(hasBranch(chain)).toBe(false)
	})

	it('is true when any node has two children', () => {
		expect(hasBranch(forked)).toBe(true)
	})

	it('is true for two roots — also not a straight line', () => {
		expect(hasBranch([rev('r1', null, 0), rev('r2', null, 1)])).toBe(true)
	})

	it('is false for an empty or single-node history', () => {
		expect(hasBranch([])).toBe(false)
		expect(hasBranch([rev('root', null, 0)])).toBe(false)
	})
})

describe('pruneToCap', () => {
	it('prunes nothing while at or under the cap', () => {
		expect(pruneToCap(chain, 'c', 4)).toEqual([])
		expect(pruneToCap(chain, 'c', 10)).toEqual([])
	})

	it('prunes the oldest LEAF, not the oldest revision', () => {
		//   root -> a -> b   (a is old but has a child; leaves are b and x)
		//   root -> x
		const tree = [rev('root', null, 0), rev('a', 'root', 1), rev('b', 'a', 2), rev('x', 'root', 3)]
		// oldest eligible leaf is b (t=2), not a (t=1, has a child)
		expect(pruneToCap(tree, 'x', 3)).toEqual(['b'])
	})

	it('never prunes the root', () => {
		const tree = [rev('root', null, 0), rev('leaf', 'root', 1)]
		// Cap of 1 would have to drop something; only `leaf` is eligible.
		expect(pruneToCap(tree, 'root', 1)).toEqual(['leaf'])
	})

	it('never prunes keepId — the revision just pushed', () => {
		const tree = [rev('root', null, 0), rev('old', 'root', 1), rev('new', 'root', 9)]
		expect(pruneToCap(tree, 'new', 2)).toEqual(['old'])
	})

	it('prunes repeatedly until it is under the cap', () => {
		const tree = [
			rev('root', null, 0),
			rev('l1', 'root', 1), rev('l2', 'root', 2), rev('l3', 'root', 3), rev('keep', 'root', 4)
		]
		expect(pruneToCap(tree, 'keep', 3)).toEqual(['l1', 'l2'])
	})

	it('gives up rather than corrupt ancestry on a pathological pure chain', () => {
		// Every non-root node has a child except the newest, which is keepId.
		// Nothing is eligible, so the cap is exceeded on purpose.
		expect(pruneToCap(chain, 'c', 2)).toEqual([])
	})

	it('re-evaluates leafness as it goes', () => {
		// root -> a -> b: after pruning b, a BECOMES a leaf and is then eligible.
		expect(pruneToCap([...chain], 'root', 2)).toEqual(['c', 'b'])
	})
})

describe('applyPrune', () => {
	it('removes exactly the pruned ids', () => {
		expect(applyPrune(forked, ['b', 'x']).map((r) => r.id)).toEqual(['root', 'a', 'y'])
	})

	it('returns a copy when nothing was pruned', () => {
		const out = applyPrune(chain, [])
		expect(out).toEqual(chain)
		expect(out).not.toBe(chain)
	})
})
