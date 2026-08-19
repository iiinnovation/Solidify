import { describe, expect, it } from 'vitest'
import { attachmentSections, formatAttachmentManifest, readAttachmentRange, searchAttachmentResources } from './types'

describe('attachment resources', () => {
  const resource = { id: 'att-1', name: '材料.md', size: 20, text: '# 结论\n第一条证据。\n第二条证据。' }

  it('keeps manifests bounded and excludes full text', () => {
    const manifest = formatAttachmentManifest([{ ...resource, text: 'x'.repeat(20_000) }])
    expect(manifest.length).toBeLessThan(6_200)
    expect(manifest).toContain('id: att-1')
    expect(manifest).not.toContain('x'.repeat(2_000))
  })

  it('reads bounded UTF-16 ranges and advances without overlap', () => {
    const first = readAttachmentRange({ ...resource, text: '甲乙丙丁戊' }, 0, 2)
    const second = readAttachmentRange({ ...resource, text: '甲乙丙丁戊' }, first.nextOffset, 2)
    expect(first.text).toBe('甲乙')
    expect(second.text).toBe('丙丁')
    expect(second.nextOffset).toBe(4)
  })

  it('searches section evidence and does not expose unknown resources', () => {
    expect(attachmentSections(resource.text)[0]?.id).toBe('section-01')
    expect(searchAttachmentResources([resource], '第二条')).toEqual([
      expect.objectContaining({ attachmentId: 'att-1', excerpt: expect.stringContaining('第二条') }),
    ])
    expect(searchAttachmentResources([], '第二条')).toEqual([])
  })
})
