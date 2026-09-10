/**
 * Public Agent runtime entry point.
 *
 * Open Agent and staged-delivery entry points share the bounded transport in
 * loop-runtime.ts. Keeping this facade stable preserves the UI/sub-agent API
 * while workflow control lives in dedicated modules.
 *
 * @module lib/engine/query
 * @see docs/specs/agent-loop.md
 */

import type { QueryContext, QueryEvent } from './types'
import { isEnabled } from '../harness/flags'
import { createRunPlan } from './run-plan'
import { deliverableRegistry } from './deliverables/registry'
import { runAgentLoop } from './agent-loop'
import { runStagedDelivery } from './staged-delivery'
import { prepareSandboxContext } from './sandbox-context'

export async function* runQuery(ctx: QueryContext): AsyncGenerator<QueryEvent> {
  ctx = await prepareSandboxContext(ctx)
  const plan = createRunPlan(ctx, deliverableRegistry, isEnabled('stagedRuntime'))
  if (plan.mode === 'staged-delivery') {
    yield* runStagedDelivery(ctx, plan)
    return
  }
  yield* runAgentLoop(ctx, plan)
}
