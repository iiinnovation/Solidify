/**
 * Default plain text deliverable contract
 * @module lib/engine/deliverables/text
 */

import type { DeliverableContract, ValidationResult } from './types'
import type { Message } from '../types'

export class TextDeliverableContract implements DeliverableContract<string> {
  readonly id = 'text'
  readonly displayName = 'Text'
  readonly version = '1.0.0'
  readonly generationCapabilities = [] as const
  readonly repairCapabilities = [] as const
  readonly maxRepairAttempts = 0

  validate(text: string): ValidationResult<string> {
    return { valid: true, artifact: text, normalizedText: text }
  }

  buildRepairMessages(_input: {
    originalTask: Message
    invalidOutput: string
    issues: readonly unknown[]
    attempt: number
  }): readonly Message[] {
    return []
  }
}

export const defaultTextContract = new TextDeliverableContract()
