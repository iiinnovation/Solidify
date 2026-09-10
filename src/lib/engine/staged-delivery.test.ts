import { describe, expect, it } from 'vitest'
import { SimpleRunLogger } from './logger'
import { PhaseController } from './phase-controller'
import type { RunPlan, RunPhase } from './run-plan'
import { drawioContract } from './deliverables/drawio'
import { StagedDeliveryController } from './staged-delivery'

const generatingPlan: RunPlan = {
  mode: 'staged-delivery',
  initialPhase: 'generating',
  contractId: 'drawio',
  attachmentMode: 'inline',
  maxRepairAttempts: 1,
  reason: 'test',
}

function controllerFor(plan: RunPlan = generatingPlan) {
  const phase = new PhaseController(plan)
  const closed = new Set<string>()
  const transitions: Array<{ next: RunPhase; reason: string }> = []
  const controller = new StagedDeliveryController(plan, phase, drawioContract, {
    transition(next, reason) {
      transitions.push({ next, reason })
      phase.transitionTo(next, reason)
    },
    closeRetrieval() {
      phase.closeGroup('attachment-retrieval')
      closed.add('attachment-retrieval')
    },
    logger: new SimpleRunLogger('staged-controller-test'),
  })
  return { controller, phase, closed, transitions }
}

describe('staged delivery controller', () => {
  it('turns retrieval end-turn into a physically closed generation phase', () => {
    const plan: RunPlan = { ...generatingPlan, initialPhase: 'retrieving', attachmentMode: 'retrieval' }
    const { controller, phase, closed } = controllerFor(plan)
    const decision = controller.handleNoToolResponse({
      text: 'draft that must be discarded',
      messages: [{ role: 'user', content: 'task' }],
      turn: 1,
      maxTurns: 10,
    })

    expect(decision.kind).toBe('continue_generation')
    expect(phase.phase).toBe('generating')
    expect(phase.evidenceComplete).toBe(true)
    expect(closed.has('attachment-retrieval')).toBe(true)
  })

  it('validates a correct artifact locally and completes', () => {
    const { controller, phase } = controllerFor()
    const artifact = '<solidify-artifact type="drawio" title="A"><mxfile><diagram/></mxfile></solidify-artifact>'
    const decision = controller.handleNoToolResponse({
      text: artifact,
      messages: [{ role: 'user', content: 'task' }],
      turn: 1,
      maxTurns: 10,
    })

    expect(decision).toEqual({ kind: 'complete', text: artifact })
    expect(phase.phase).toBe('completed')
  })

  it('repairs once without reopening retrieval, then fails deterministically', () => {
    const { controller, phase, closed } = controllerFor()
    const first = controller.handleNoToolResponse({
      text: 'invalid',
      messages: [{ role: 'user', content: 'task' }],
      turn: 1,
      maxTurns: 10,
    })

    expect(first.kind).toBe('repair')
    expect(phase.phase).toBe('repairing')
    expect(phase.repairAttempts).toBe(1)
    expect(closed.has('attachment-retrieval')).toBe(true)
    if (first.kind === 'repair') {
      expect(JSON.stringify(first.messages)).toContain('校验未通过原因')
      expect(JSON.stringify(first.messages)).toContain('invalid')
    }

    const second = controller.handleNoToolResponse({
      text: 'still invalid',
      messages: first.kind === 'repair' ? first.messages : [],
      turn: 2,
      maxTurns: 10,
    })
    expect(second.kind).toBe('failed')
    expect(phase.phase).toBe('failed')
    expect(phase.repairAttempts).toBe(1)
  })

  it('advances an empty retrieval lease before a provider call', () => {
    const plan: RunPlan = { ...generatingPlan, initialPhase: 'retrieving', attachmentMode: 'retrieval' }
    const { controller, phase, closed } = controllerFor(plan)
    expect(controller.advancePastEmptyRetrievalLease(0)).toBe(true)
    expect(phase.phase).toBe('generating')
    expect(closed.has('attachment-retrieval')).toBe(true)
  })
})
