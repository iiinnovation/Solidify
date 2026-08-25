/**
 * PhaseController: Deterministic phase state transitions
 * @module lib/engine/phase-controller
 */

import type { RunPlan, RunPhase } from './run-plan'

export interface PhaseState {
  readonly phase: RunPhase
  readonly turn: number
  readonly repairAttempts: number
  readonly evidenceComplete: boolean
  readonly closedGroups: ReadonlySet<string>
}

export interface SerializedPhaseState {
  readonly phase: RunPhase
  readonly turn: number
  readonly repairAttempts: number
  readonly evidenceComplete: boolean
  readonly closedGroups: readonly string[]
}

export interface PhaseTransition {
  readonly from: RunPhase
  readonly to: RunPhase
  readonly reason: string
}

const LEGAL_TRANSITIONS: Readonly<Record<RunPhase, ReadonlySet<RunPhase>>> = {
  preparing: new Set(['retrieving', 'generating', 'failed', 'exhausted']),
  retrieving: new Set(['generating', 'completed', 'failed', 'exhausted']),
  generating: new Set(['validating', 'completed', 'failed', 'exhausted']),
  validating: new Set(['repairing', 'completed', 'failed', 'exhausted']),
  repairing: new Set(['validating', 'completed', 'failed', 'exhausted']),
  completed: new Set(),
  failed: new Set(),
  exhausted: new Set(),
}

export class PhaseController {
  private phase_: RunPhase
  private turn_ = 0
  private repairAttempts_ = 0
  private evidenceComplete_ = false
  private closedGroups_ = new Set<string>()

  readonly plan: RunPlan

  constructor(plan: RunPlan, restored?: SerializedPhaseState) {
    this.plan = plan
    this.phase_ = restored?.phase ?? plan.initialPhase
    this.turn_ = restored?.turn ?? 0
    this.repairAttempts_ = restored?.repairAttempts ?? 0
    this.evidenceComplete_ = restored?.evidenceComplete ?? false
    this.closedGroups_ = new Set(restored?.closedGroups ?? [])
    if (!phaseAllowedByPlan(plan, this.phase_)) {
      throw new Error(`Phase ${this.phase_} is incompatible with run mode ${plan.mode}`)
    }
    if (this.repairAttempts_ > plan.maxRepairAttempts) {
      throw new Error(`Snapshot repair attempts ${this.repairAttempts_} exceed contract limit ${plan.maxRepairAttempts}`)
    }
  }

  get state(): PhaseState {
    return {
      phase: this.phase_,
      turn: this.turn_,
      repairAttempts: this.repairAttempts_,
      evidenceComplete: this.evidenceComplete_,
      closedGroups: new Set(this.closedGroups_),
    }
  }

  get phase(): RunPhase {
    return this.phase_
  }

  get turn(): number {
    return this.turn_
  }

  get repairAttempts(): number {
    return this.repairAttempts_
  }

  get closedGroups(): ReadonlySet<string> {
    return this.closedGroups_
  }

  get evidenceComplete(): boolean {
    return this.evidenceComplete_
  }

  serialize(): SerializedPhaseState {
    return {
      phase: this.phase_,
      turn: this.turn_,
      repairAttempts: this.repairAttempts_,
      evidenceComplete: this.evidenceComplete_,
      closedGroups: [...this.closedGroups_].sort(),
    }
  }

  incrementTurn(): number {
    this.turn_ += 1
    return this.turn_
  }

  incrementRepair(): number {
    if (this.repairAttempts_ >= this.plan.maxRepairAttempts) {
      throw new Error(`Repair attempt limit reached: ${this.plan.maxRepairAttempts}`)
    }
    this.repairAttempts_ += 1
    return this.repairAttempts_
  }

  markEvidenceComplete(): void {
    this.evidenceComplete_ = true
  }

  closeGroup(group: string): void {
    this.closedGroups_.add(group)
  }

  transitionTo(next: RunPhase, reason: string): PhaseTransition {
    const from = this.phase_
    if (!LEGAL_TRANSITIONS[from].has(next)) {
      throw new Error(`Invalid phase transition: ${from} -> ${next} (${reason})`)
    }
    this.phase_ = next
    return { from, to: next, reason }
  }
}

function phaseAllowedByPlan(plan: RunPlan, phase: RunPhase): boolean {
  if (phase === 'completed' || phase === 'failed' || phase === 'exhausted') return true
  if (plan.mode === 'direct') return phase === 'generating'
  if (plan.mode === 'agent') return phase === 'preparing' || phase === 'retrieving' || phase === 'generating'
  return true
}
