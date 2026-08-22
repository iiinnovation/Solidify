import { describe, expect, it } from 'vitest'
import type { ToolUseContext } from '../types'
import { prepareAttachmentEvidenceTool, readAttachmentTool, searchAttachmentsTool } from './attachments'

const signal = new AbortController().signal
const context = {
  attachments: [{ id: 'att-current', name: 'report.md', size: 60, text: '# Summary\nRevenue increased by 20%.\n# Secret\nDo not cross section boundaries.' }],
} as unknown as ToolUseContext

describe('attachment tools', () => {
  it('searches only resources attached to the current run', async () => {
    const result = await searchAttachmentsTool.execute({ query: 'Revenue' }, context, signal)
    expect(result.success).toBe(true)
    expect(result.content).toContain('report.md')

    const excluded = await searchAttachmentsTool.execute({ query: 'Revenue', attachmentIds: ['att-other'] }, context, signal)
    expect(excluded.success).toBe(false)
    expect(excluded.error?.kind).toBe('not_found')

    const mixed = await searchAttachmentsTool.execute({ query: 'Revenue', attachmentIds: ['att-current', 'att-other'] }, context, signal)
    expect(mixed.success).toBe(false)
  })

  it('rejects unknown IDs and bounds every read', async () => {
    const denied = await readAttachmentTool.execute({ attachmentId: 'att-other' }, context, signal)
    expect(denied.success).toBe(false)
    expect(denied.error?.kind).toBe('not_found')

    const read = await readAttachmentTool.execute({ attachmentId: 'att-current', offset: 0, limit: 10 }, context, signal)
    expect(read.success).toBe(true)
    expect(read.content).toContain('# Summary')
    expect((read.data as { nextOffset?: number }).nextOffset).toBe(10)

    const section = await readAttachmentTool.execute({ attachmentId: 'att-current', sectionId: 'section-01', limit: 8_000 }, context, signal)
    expect(section.content).toContain('Revenue increased')
    expect(section.content).not.toContain('Do not cross')
    expect((section.data as { nextOffset?: number }).nextOffset).toBeUndefined()
  })

  it('continues a long section from the caller-provided offset without crossing into the next section', async () => {
    const longContext = {
      attachments: [{
        id: 'att-long',
        name: 'long.md',
        size: 10_000,
        text: `# Long\n${'A'.repeat(9_000)}\n# Next\nprivate`,
      }],
    } as unknown as ToolUseContext

    const first = await readAttachmentTool.execute(
      { attachmentId: 'att-long', sectionId: 'section-01', limit: 8_000 },
      longContext,
      signal,
    )
    expect((first.data as { nextOffset?: number }).nextOffset).toBe(8_000)

    const second = await readAttachmentTool.execute(
      { attachmentId: 'att-long', sectionId: 'section-01', offset: 8_000, limit: 8_000 },
      longContext,
      signal,
    )
    expect((second.data as { offset: number; nextOffset?: number }).offset).toBe(8_000)
    expect(second.content).not.toContain('# Next')
    expect((second.data as { nextOffset?: number }).nextOffset).toBeUndefined()
  })

  it('prepares a bounded evidence pack with source coordinates', async () => {
    const result = await prepareAttachmentEvidenceTool.execute({ maxChars: 120 }, context, signal)
    expect(result.success).toBe(true)
    expect(result.content).toContain('source attachment:att-current')
    expect(result.content).toContain('section:section-01')
    expect(result.content).toContain('Revenue increased')
    expect((result.data as { entries: Array<{ offset: number }>; truncated: boolean }).entries[0]?.offset).toBe(0)
  })

  it('rejects unknown evidence IDs without reading another resource', async () => {
    const result = await prepareAttachmentEvidenceTool.execute({ attachmentIds: ['att-other'] }, context, signal)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('not_found')
  })
})
