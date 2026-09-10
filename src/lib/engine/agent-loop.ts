/**
 * Open-ended Agent loop entry.
 *
 * The model decides when to use the leased tools, while loop-runtime enforces
 * budgets, permissions, recovery and event ordering. A run can still activate
 * a contract-backed Skill dynamically; the staged factory handles that
 * monotonic transition without duplicating the transport loop.
 *
 * @module lib/engine/agent-loop
 */

import type { QueryContext, QueryEvent } from './types'
import type { RunPlan } from './run-plan'
import { runBoundedLoop } from './loop-runtime'
import { createStagedDeliveryController } from './staged-delivery'

export async function* runAgentLoop(
  ctx: QueryContext,
  plan: RunPlan,
): AsyncGenerator<QueryEvent> {
  yield* runBoundedLoop(ctx, plan, createStagedDeliveryController)
}
