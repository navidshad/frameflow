/**
 * The undo-history ring cap, extracted so it can be tested — main's
 * editor/history.ts imports `app` from electron and cannot be unit-tested.
 * Mirrors shared/revision-tree.ts, which does the same for the revisions cap.
 */

export interface CappableStep {
	id: string
}

export interface CappableKeyframe {
	stepId: string
}

export interface StepCapResult<S extends CappableStep, K extends CappableKeyframe> {
	steps: S[]
	keyframes: K[]
	/** Ids the cap evicted, so the renderer can drop them instead of guessing. */
	prunedIds: string[]
}

/**
 * Keep the newest `max` steps.
 *
 * Keyframes are periodic full snapshots used to replay an undo without walking
 * every inverse diff. When steps are evicted their keyframes go too — except
 * the newest evicted one, which is promoted to the front as the replay
 * baseline. Drop that and the oldest surviving steps have nothing to replay
 * from.
 */
export function applyStepCap<S extends CappableStep, K extends CappableKeyframe>(
	steps: readonly S[],
	keyframes: readonly K[],
	max: number
): StepCapResult<S, K> {
	if (steps.length <= max) {
		return { steps: [...steps], keyframes: [...keyframes], prunedIds: [] }
	}

	const evicted = steps.slice(0, steps.length - max)
	const kept = steps.slice(steps.length - max)
	const validIds = new Set(kept.map((s) => s.id))

	const orphaned = keyframes.filter((k) => !validIds.has(k.stepId))
	const baseline = orphaned[orphaned.length - 1]
	const survivingKeyframes = keyframes.filter((k) => validIds.has(k.stepId))

	return {
		steps: kept,
		keyframes: baseline ? [baseline, ...survivingKeyframes] : survivingKeyframes,
		prunedIds: evicted.map((s) => s.id)
	}
}
