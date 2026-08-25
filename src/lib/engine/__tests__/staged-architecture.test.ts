import { describe, expect, it } from 'vitest'
import { createRunPlan } from '../run-plan'
import { resolveCapabilityLease } from '../capability-policy'
import { PhaseController } from '../phase-controller'
import { deliverableRegistry } from '../deliverables/registry'
import type { QueryContext } from '../types'
import type { Tool } from '../../tools/types'
import { InMemoryState } from '../../memory'
import type { DeliverableContract } from '../deliverables/types'

const DRAWIO_SKILL = {
  metadata: { name: 'drawio-diagram', version: '1.0.0', description: 'draw', deliverableContract: 'drawio' },
  content: '',
  path: '',
} as const

function makeTool(name: string, loopGroup?: string): Tool {
  return {
    name,
    description: name,
    loopGroup,
    inputSchema: { type: 'object' },
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    requiresConfirmation: false,
    terminalOnFailure: false,
    availability: 'always',
    permissions: [],
    execute: async () => ({ success: true, content: 'ok' }),
    renderCall: () => name,
  }
}

function makeCtx(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'run-test',
    conversationId: 'conversation-test',
    cwd: '/workspace',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock-model' },
    limits: { maxTurns: 10, maxTokens: 100_000, maxOutputTokens: 4096, maxToolCalls: 20, toolTimeoutMs: 10_000 },
    signal: new AbortController().signal,
    providerRegistry: { get: () => undefined } as never,
    ...overrides,
  }
}

describe('Staged Workflow Core Abstractions (PR-2)', () => {
  describe('createRunPlan', () => {
    it('plans direct mode for standard conversation with no tools', () => {
      const plan = createRunPlan(makeCtx({ tools: [] }))
      expect(plan.mode).toBe('direct')
      expect(plan.initialPhase).toBe('generating')
      expect(plan.attachmentMode).toBe('none')
    })

    it('plans staged-delivery with retrieving phase for drawio with retrieval attachments', () => {
      const plan = createRunPlan(makeCtx({
        skill: DRAWIO_SKILL,
        attachments: [{ id: 'att-1', name: 'arch.txt', mimeType: 'text/plain', size: 100, text: 'some text' }],
        attachmentMode: 'retrieval',
      }), deliverableRegistry)
      expect(plan.mode).toBe('staged-delivery')
      expect(plan.initialPhase).toBe('retrieving')
      expect(plan.contractId).toBe('drawio')
      expect(plan.maxRepairAttempts).toBe(1)
    })

    it('plans staged-delivery with generating phase for drawio with inline attachments', () => {
      const plan = createRunPlan(makeCtx({
        skill: DRAWIO_SKILL,
        attachments: [{ id: 'att-1', name: 'arch.txt', mimeType: 'text/plain', size: 100, text: 'some text' }],
        attachmentMode: 'inline',
      }), deliverableRegistry)
      expect(plan.mode).toBe('staged-delivery')
      expect(plan.initialPhase).toBe('generating')
      expect(plan.contractId).toBe('drawio')
    })

    it('plans open-ended agent mode for general workspace runs', () => {
      const plan = createRunPlan(makeCtx({
        tools: [makeTool('read_file'), makeTool('write_file')],
      }))
      expect(plan.mode).toBe('agent')
      expect(plan.initialPhase).toBe('generating')
    })

    it('keeps a rollback path when staged runtime is disabled', () => {
      const plan = createRunPlan(makeCtx({ skill: DRAWIO_SKILL }), deliverableRegistry, false)
      expect(plan.mode).toBe('agent')
      expect(plan.contractId).toBeUndefined()
    })
  })

  describe('resolveCapabilityLease', () => {
    const allTools: Tool[] = [
      makeTool('read_attachment', 'attachment-retrieval'),
      makeTool('search_attachments', 'attachment-retrieval'),
      makeTool('read_file'),
      makeTool('write_file'),
    ]

    it('grants no tools for direct mode', () => {
      const plan = createRunPlan(makeCtx({ tools: [] }))
      const lease = resolveCapabilityLease({ plan, phase: 'generating' }, allTools)
      expect(lease.tools).toHaveLength(0)
      expect(lease.toolChoice).toBe('none')
    })

    it('grants only attachment tools during staged-delivery retrieving phase', () => {
      const plan = createRunPlan(makeCtx({
        skill: DRAWIO_SKILL,
        attachments: [{ id: 'att-1', name: 'arch.txt', mimeType: 'text/plain', size: 100, text: 'some text' }],
        attachmentMode: 'retrieval',
      }), deliverableRegistry)
      const lease = resolveCapabilityLease({ plan, phase: 'retrieving', contract: deliverableRegistry.get('drawio') }, allTools)
      expect(lease.tools.map((t) => t.name)).toEqual(['read_attachment', 'search_attachments'])
      expect(lease.toolChoice).toBe('auto')
    })

    it('physically isolates and strips all tools during staged-delivery generating phase', () => {
      const plan = createRunPlan(makeCtx({ skill: DRAWIO_SKILL }), deliverableRegistry)
      const lease = resolveCapabilityLease({ plan, phase: 'generating', contract: deliverableRegistry.get('drawio') }, allTools)
      expect(lease.tools).toHaveLength(0)
      expect(lease.toolChoice).toBe('none')
    })

    it('physically isolates and strips all tools during staged-delivery repairing phase', () => {
      const plan = createRunPlan(makeCtx({ skill: DRAWIO_SKILL }), deliverableRegistry)
      const lease = resolveCapabilityLease({ plan, phase: 'repairing', contract: deliverableRegistry.get('drawio') }, allTools)
      expect(lease.tools).toHaveLength(0)
      expect(lease.toolChoice).toBe('none')
    })

    it('honors contract capabilities without reopening a closed retrieval group', () => {
      const plan = createRunPlan(makeCtx({ skill: DRAWIO_SKILL }), deliverableRegistry)
      const base = deliverableRegistry.get('drawio')
      const contract: DeliverableContract = {
        id: 'test-contract',
        displayName: 'Test',
        version: '1.0.0',
        generationCapabilities: ['write_file'],
        repairCapabilities: ['read_attachment'],
        maxRepairAttempts: 1,
        validate: (text) => base.validate(text),
        buildRepairMessages: (input) => base.buildRepairMessages(input),
      }
      const generation = resolveCapabilityLease({ plan, phase: 'generating', contract }, allTools)
      const repair = resolveCapabilityLease({
        plan,
        phase: 'repairing',
        contract,
        closedGroups: new Set(['attachment-retrieval']),
      }, allTools)

      expect(generation.tools.map((tool) => tool.name)).toEqual(['write_file'])
      expect(repair.tools).toEqual([])
    })

    it('filters closed groups in agent mode', () => {
      const plan = createRunPlan(makeCtx({ tools: allTools }))
      const closed = new Set(['attachment-retrieval'])
      const lease = resolveCapabilityLease({ plan, phase: 'generating', closedGroups: closed }, allTools)
      expect(lease.tools.map((t) => t.name)).toEqual(['read_file', 'write_file'])
      expect(lease.toolChoice).toBe('auto')
    })
  })

  describe('PhaseController', () => {
    it('manages sequential transitions and maintains state counters', () => {
      const plan = createRunPlan(makeCtx({
        skill: DRAWIO_SKILL,
        attachments: [{ id: 'att-1', name: 'arch.txt', mimeType: 'text/plain', size: 100, text: 'some text' }],
        attachmentMode: 'retrieval',
      }), deliverableRegistry)
      const controller = new PhaseController(plan)
      expect(controller.phase).toBe('retrieving')
      expect(controller.turn).toBe(0)

      controller.incrementTurn()
      expect(controller.turn).toBe(1)

      const trans1 = controller.transitionTo('generating', 'evidence_collected')
      expect(trans1).toEqual({ from: 'retrieving', to: 'generating', reason: 'evidence_collected' })
      expect(controller.phase).toBe('generating')

      const trans2 = controller.transitionTo('validating', 'output_produced')
      expect(trans2.to).toBe('validating')

      const trans3 = controller.transitionTo('repairing', 'syntax_error')
      expect(trans3.to).toBe('repairing')
      controller.incrementRepair()
      expect(controller.repairAttempts).toBe(1)

      controller.transitionTo('validating', 'delivery_regenerated')
      const trans4 = controller.transitionTo('completed', 'delivery_valid')
      expect(trans4.to).toBe('completed')
    })

    it('rejects illegal transitions and terminal-state escape', () => {
      const plan = createRunPlan(makeCtx({ skill: DRAWIO_SKILL }), deliverableRegistry)
      const controller = new PhaseController(plan)
      expect(() => controller.transitionTo('retrieving', 'regression')).toThrow(/Invalid phase transition/)
      controller.transitionTo('completed', 'done')
      expect(() => controller.transitionTo('generating', 'restart')).toThrow(/Invalid phase transition/)
    })
  })

  describe('DeliverableContractRegistry', () => {
    it('returns default text contract when queried without an id', () => {
      const contract = deliverableRegistry.get()
      expect(contract.id).toBe('text')
      expect(contract.validate('hello').valid).toBe(true)
    })

    it('fails explicitly for an unknown contract', () => {
      expect(() => deliverableRegistry.get('missing')).toThrow(/Unknown deliverable contract/)
    })
  })
})
