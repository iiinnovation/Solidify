/**
 * DeliverableContract: Unified contract for structured deliverables
 * @module lib/engine/deliverables/types
 */

import type { Message } from '../types'

export interface ValidationIssue {
  readonly code: string
  readonly message: string
  readonly path?: string
}

export type ValidationResult<TArtifact = unknown> =
  | { readonly valid: true; readonly artifact: TArtifact; readonly normalizedText?: string }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] }

export interface DeliverableContract<TArtifact = unknown> {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly generationCapabilities: readonly string[]
  readonly repairCapabilities: readonly string[]
  readonly maxRepairAttempts: number

  validate(text: string): ValidationResult<TArtifact>
  buildRepairMessages(input: {
    originalTask: Message
    invalidOutput: string
    issues: readonly ValidationIssue[]
    attempt: number
  }): readonly Message[]
}
