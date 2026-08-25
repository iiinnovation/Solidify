/**
 * Draw.io deliverable contract
 * @module lib/engine/deliverables/drawio
 */

import type { DeliverableContract, ValidationIssue, ValidationResult } from './types'
import type { Message } from '../types'

const DRAWIO_DELIVERY_REPAIR_CONTEXT = [
  'Your previous response was rejected because it was not a valid Draw.io Artifact.',
  'There are no tools available now. Text such as <tool_call> is invalid output and will not execute.',
  'Return only one <solidify-artifact type="drawio" title="..."> element containing one complete <mxfile>...</mxfile>, then close </solidify-artifact>.',
  'Do not include commentary, Markdown fences, plans, or tool syntax.',
].join(' ')

export class DrawioDeliverableContract implements DeliverableContract<{ title?: string; content: string }> {
  readonly id = 'drawio'
  readonly displayName = 'Draw.io'
  readonly version = '1.0.0'
  readonly generationCapabilities = [] as const
  readonly repairCapabilities = [] as const
  readonly maxRepairAttempts = 1

  validate(text: string): ValidationResult<{ title?: string; content: string }> {
    const matches = [...text.matchAll(/<solidify-artifact\b([^>]*)>([\s\S]*?)<\/solidify-artifact>/gi)]
    if (matches.length !== 1) {
      return {
        valid: false,
        issues: [{ code: 'invalid_artifact_count', message: `需要且只能包含一个 Artifact，实际为 ${matches.length} 个` }],
      }
    }
    const match = matches[0]
    const prefix = text.slice(0, match.index).trim()
    const suffix = text.slice((match.index ?? 0) + match[0].length).trim()
    if (prefix || suffix) {
      return {
        valid: false,
        issues: [{ code: 'extra_commentary', message: 'Artifact 前后不能包含说明文字或工具调用标签' }],
      }
    }
    if (!/\btype\s*=\s*(?:"drawio"|'drawio')/i.test(match[1])) {
      return {
        valid: false,
        issues: [{ code: 'invalid_artifact_type', message: 'Artifact type 必须为 drawio' }],
      }
    }
    if (!/<mxfile\b[\s\S]*<\/mxfile\s*>/i.test(match[2])) {
      return {
        valid: false,
        issues: [{ code: 'missing_mxfile', message: 'Artifact 内缺少完整的 mxfile XML' }],
      }
    }
    const titleMatch = match[1].match(/\btitle\s*=\s*["']([^"']+)["']/i)
    return {
      valid: true,
      artifact: {
        title: titleMatch ? titleMatch[1] : 'Diagram',
        content: match[2],
      },
      normalizedText: match[0],
    }
  }

  buildRepairMessages(input: {
    originalTask: Message
    invalidOutput: string
    issues: readonly ValidationIssue[]
    attempt: number
  }): readonly Message[] {
    const issueSummary = input.issues.map((i) => i.message).join('；')
    const prompt = `${DRAWIO_DELIVERY_REPAIR_CONTEXT}\n\n[校验未通过原因]: ${issueSummary}`
    return [
      { role: 'assistant', content: '[Invalid Draw.io delivery omitted.]' },
      { role: 'user', content: prompt },
    ]
  }
}

export const drawioContract = new DrawioDeliverableContract()
