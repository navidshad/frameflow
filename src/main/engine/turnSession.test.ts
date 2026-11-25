import { describe, expect, it } from 'vitest'
import { recordCommit, type CommitRecord } from './turnSession'

const outcome = (revisionId: string, seq: number, added: number, updated = 0) => ({
	ok: true as const, revisionId, revisionSeq: seq, parentRevisionId: 'r4',
	counts: { added, removed: 0, updated, markers: 0 }, pruned: []
})

describe('what an engine turn made', () => {
	it('lists the request’s one revision once, with every edit counted', () => {
		const commits: CommitRecord[] = []
		recordCommit(commits, outcome('r5', 5, 2))
		recordCommit(commits, outcome('r5', 5, 1, 3))
		recordCommit(commits, outcome('r5', 5, 0, 1))
		expect(commits).toEqual([{ revisionId: 'r5', revisionSeq: 5, parentRevisionId: 'r4', counts: { added: 3, removed: 0, updated: 4, markers: 0 } }])
	})

	it('lists a second revision when the agent switched versions on purpose', () => {
		const commits: CommitRecord[] = []
		recordCommit(commits, outcome('r5', 5, 1))
		recordCommit(commits, outcome('r7', 7, 1))
		expect(commits.map((c) => c.revisionSeq)).toEqual([5, 7])
	})
})
