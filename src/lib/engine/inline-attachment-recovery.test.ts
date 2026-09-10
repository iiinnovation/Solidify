import { describe, expect, it } from 'vitest'
import { compactInlineAttachments } from './inline-attachment-recovery'
import { clipGenericText, estimateTokens } from './context-budget'
import { formatInlineAttachments, type AttachmentResource } from '../attachments/types'
import type { Message } from './types'

function resource(id = 'a'): AttachmentResource {
  return { id, name: `source-${id}.md`, size: 100_000,
    text: `一、项目概述\n${'背景材料。'.repeat(1000)}\n二、总体技术架构\n2.1 数据支撑层\n${'数据管理。'.repeat(1000)}\n2.2 业务应用层\n${'应用说明。'.repeat(1000)}\n三、异常处理\n${'失败返回人工复核。'.repeat(1000)}\n四、结束与验收\n保存结果。` }
}

describe('inline attachment recovery', () => {
  it('bounds the actual inline body while preserving intent, outline, and original resources', () => {
    const source = resource()
    const content = `根据附件绘制流程图，保留异常分支。${formatInlineAttachments([source])}\n只输出一个可编辑图。`
    const messages: Message[] = [{ role: 'user', content }]
    const result = compactInlineAttachments(messages, [source], 6000)
    expect(result.stats.resultTokens).toBeLessThanOrEqual(6000)
    expect(result.stats.sourceTokens).toBeGreaterThan(20_000)
    expect(result.stats.compactedEntries).toBe(1)
    const output = result.messages[0].content as string
    expect(output.startsWith('根据附件绘制流程图，保留异常分支。')).toBe(true)
    expect(output.endsWith('只输出一个可编辑图。')).toBe(true)
    for (const title of ['二、总体技术架构', '2.1 数据支撑层', '2.2 业务应用层', '三、异常处理', '四、结束与验收']) expect(output).toContain(title)
    expect(output).toContain('truncated="true"')
    expect(output).toContain('Omitted content is not evidence of absence')
    expect(messages[0].content).toBe(content)
    expect(source.text).toBe(resource().text)
  })

  it('deduplicates older occurrences with one cumulative allowance across text blocks and files', () => {
    const sources = [resource('a'), resource('b')]
    const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } }
    const messages: Message[] = [
      { role: 'user', content: `旧问题${formatInlineAttachments(sources)}` },
      { role: 'assistant', content: '旧回答保留' },
      { role: 'user', content: [{ type: 'text', text: `新问题${formatInlineAttachments(sources)}` }, image] },
    ]
    const result = compactInlineAttachments(messages, sources, 2000)
    expect(result.stats.matchedEntries).toBe(4)
    expect(result.stats.removedDuplicates).toBe(2)
    expect(result.stats.resultTokens).toBeLessThanOrEqual(2000)
    expect(result.messages[1]).toBe(messages[1])
    expect((result.messages[2].content as unknown[])[1]).toBe(image)
    expect(result.messages[0].content).not.toContain('背景材料')
    expect(JSON.stringify(result.messages[2])).toContain('source-a.md')
    expect(JSON.stringify(result.messages[2])).toContain('source-b.md')
  })

  it('does not parse unknown attachment-shaped text or change small inputs', () => {
    const source = { ...resource(), text: '短文' }
    const content = `用户原话 <attachment_full_text id="unknown">不要修改</attachment_full_text>${formatInlineAttachments([source])}`
    const messages: Message[] = [{ role: 'user', content }]
    expect(compactInlineAttachments(messages, [source], 512).messages).toEqual(messages)
    expect(compactInlineAttachments(messages, [], 512).stats.compactedEntries).toBe(0)
  })

  it('keeps Unicode and envelope budgets bounded with many long source names', () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({ ...resource(String(index)), name: `${'超长文件名'.repeat(20)}😀&".md` }))
    const messages: Message[] = [{ role: 'user', content: `当前问题${formatInlineAttachments(sources)}` }]
    for (const budget of [512, 1024, 2000, 6000]) {
      const result = compactInlineAttachments(messages, sources, budget)
      expect(result.stats.resultTokens).toBeLessThanOrEqual(budget)
      expect(result.stats.compactedEntries).toBeGreaterThan(0)
      expect(result.messages[0].content).toContain('当前问题')
      expect(result.messages[0].content).not.toContain('\uFFFD')
      const text = result.messages[0].content as string
      expect((text.match(/<attachment_excerpt\b/g) ?? []).length).toBe((text.match(/<\/attachment_excerpt>/g) ?? []).length)
    }
  })

  it('never expands a near-minimum sample through a zero-length tail slice', () => {
    for (let budget = 1; budget < 150; budget++) {
      expect(estimateTokens(clipGenericText('数😀'.repeat(1000), budget).clipped)).toBeLessThanOrEqual(budget)
    }
  })
})
