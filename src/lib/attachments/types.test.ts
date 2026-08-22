import { describe, expect, it } from 'vitest'
import { attachmentSections, buildAttachmentEvidencePack, chooseAttachmentContextMode, formatAttachmentManifest, formatInlineAttachments, readAttachmentRange, searchAttachmentResources } from './types'

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

  it('treats OR queries as alternatives and returns later matches in long sections', () => {
    const long = {
      id: 'att-arch',
      name: '架构.md',
      size: 200,
      text: '总体技术架构见后文。' + '前言。'.repeat(250) + '\n模型服务层：统一模型网关与算法服务。',
    }
    const hits = searchAttachmentResources([long], '总体技术架构 OR 模型服务层', 20)
    expect(hits.some((hit) => hit.excerpt.includes('模型服务层'))).toBe(true)
  })

  it('inlines small text attachments only for explicit full-reading requests', () => {
    const resources = [{ id: 'a', name: 'brief.md', size: 30, text: 'x'.repeat(30) }]
    expect(chooseAttachmentContextMode({ resources, userContent: '请完整阅读附件并给出结论', contextWindow: 1_000 })).toBe('inline')
    expect(chooseAttachmentContextMode({ resources, userContent: '请阅读附件，分步骤完成多个交付物', contextWindow: 1_000 })).toBe('retrieval')
    expect(chooseAttachmentContextMode({ resources, userContent: '请总结附件', contextWindow: 1_000 })).toBe('retrieval')
  })

  it('keeps large inline candidates on retrieval', () => {
    const resources = [{ id: 'a', name: 'large.md', size: 100_000, text: 'x'.repeat(10_000) }]
    expect(chooseAttachmentContextMode({ resources, userContent: '请通读全文', contextWindow: 1_000 })).toBe('retrieval')
  })

  it('formats inline text as a bounded data envelope', () => {
    const output = formatInlineAttachments([{ id: 'a', name: 'brief.md', size: 3, text: '正文' }])
    expect(output).toContain('<attachment_full_text id="a" name="brief.md">')
    expect(output).toContain('正文')
    expect(output).toContain('</attachments_inline>')
  })

  it('builds a bounded evidence pack before the model turn with source coordinates', () => {
    const pack = buildAttachmentEvidencePack([{ ...resource, text: '# 结论\n' + '证据。'.repeat(2_000) }], undefined, 1_000)
    expect(pack?.content).toContain('[source attachment:att-1')
    expect(pack?.entries[0]).toMatchObject({ attachmentId: 'att-1', sectionId: 'section-01', offset: 0 })
    expect(pack?.content.length).toBeLessThanOrEqual(1_050)
    expect(pack?.truncated).toBe(true)
  })
})
