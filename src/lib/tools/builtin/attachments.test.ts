import { describe, expect, it } from 'vitest'
import type { ToolUseContext } from '../types'
import { readAttachmentTool, searchAttachmentsTool } from './attachments'

const signal = new AbortController().signal
const context = {
  attachments: [{ id: 'att-current', name: 'report.md', size: 30, text: '# Summary\nRevenue increased by 20%.' }],
} as unknown as ToolUseContext

describe('attachment tools', () => {
  it('searches only resources attached to the current run', async () => {
    const result = await searchAttachmentsTool.execute({ query: 'Revenue' }, context, signal)
    expect(result.success).toBe(true)
    expect(result.content).toContain('report.md')

    const excluded = await searchAttachmentsTool.execute({ query: 'Revenue', attachmentIds: ['att-other'] }, context, signal)
    expect(excluded.success).toBe(false)
    expect(excluded.error?.kind).toBe('not_found')
  })

  it('rejects unknown IDs and bounds every read', async () => {
    const denied = await readAttachmentTool.execute({ attachmentId: 'att-other' }, context, signal)
    expect(denied.success).toBe(false)
    expect(denied.error?.kind).toBe('not_found')

    const read = await readAttachmentTool.execute({ attachmentId: 'att-current', offset: 0, limit: 10 }, context, signal)
    expect(read.success).toBe(true)
    expect(read.content).toContain('# Summary')
    expect((read.data as { nextOffset?: number }).nextOffset).toBe(10)
  })
})
