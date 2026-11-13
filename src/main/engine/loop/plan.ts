import { tool } from 'ai'
import { z } from 'zod'
import { PLAN_TOOL, type PlanItem } from '@shared/engines'

/**
 * The agent's own plan: what Claude Code gets from its todo tool and Deep Agents
 * from `write_todos`. It lives in the loop, not on FrameFlow's MCP server (an
 * outside agent has its own), changes nothing in the project, and costs no tool
 * call from the budget. The chat shows it as a step titled with where the agent
 * is in it.
 */

export const planSchema = z.object({
	items: z.array(z.object({
		step: z.string().min(1).describe('One step, in a few words.'),
		status: z.enum(['pending', 'in_progress', 'completed'])
	})).min(1).max(12).describe('The whole plan, every time: the full list with each step’s current status.')
})

export function createPlanTool(onPlan?: (items: PlanItem[]) => void) {
	return {
		[PLAN_TOOL]: tool({
			description:
				'Write down or update your plan for a request with several parts. Send the whole list every time. ' +
				'Mark the step you are on in_progress and the ones you have finished completed. It does not change the project.',
			inputSchema: planSchema,
			execute: async ({ items }) => {
				onPlan?.(items)
				const done = items.filter((i) => i.status === 'completed').length
				return `Plan saved: ${done} of ${items.length} done.`
			}
		})
	}
}
