import { describe, expect, it } from 'vitest'
import { processStreamingContent } from './use-chat'

describe('streaming artifact parser', () => {
  it('accepts path in any attribute order and removes completed blocks from chat text', () => {
    const result = processStreamingContent('说明\n<solidify-artifact path="03-交付物/规格.md" type="document" title="需求规格"># 内容</solidify-artifact>\n完成')
    expect(result.cleanText).toBe('说明\n\n完成')
    expect(result.completeArtifacts).toEqual([{ title: '需求规格', type: 'document', path: '03-交付物/规格.md', content: '# 内容' }])
  })

  it('derives a safe path while the closing tag is still streaming', () => {
    const result = processStreamingContent('<solidify-artifact title="流程/图" type="diagram">graph TD')
    expect(result.streamingArtifact).toMatchObject({ title: '流程/图', type: 'mermaid', path: '03-交付物/流程-图.mmd', content: 'graph TD' })
  })

  it('decodes escaped artifact title attributes', () => {
    const result = processStreamingContent('<solidify-artifact title="A &quot;quote&quot; &amp; B" type="document">body</solidify-artifact>')
    expect(result.completeArtifacts[0].title).toBe('A "quote" & B')
  })

  it('promotes a partial naked mxfile response to a streaming Draw.io artifact', () => {
    const xml = '<mxfile><diagram name="审批流程"><mxGraphModel><root>'
    const result = processStreamingContent(xml)

    expect(result.cleanText).toBe('')
    expect(result.completeArtifacts).toEqual([])
    expect(result.streamingArtifact).toEqual({
      title: '审批流程',
      type: 'drawio',
      path: '03-交付物/审批流程.drawio',
      content: xml,
    })
  })

  it('promotes a complete fenced mxfile response and removes it from chat text', () => {
    const xml = '<mxfile><diagram name="系统架构"><mxGraphModel><root /></mxGraphModel></diagram></mxfile>'
    const result = processStreamingContent(`\`\`\`xml\n<?xml version="1.0"?>\n${xml}\n\`\`\``)

    expect(result.cleanText).toBe('')
    expect(result.streamingArtifact).toBeNull()
    expect(result.completeArtifacts).toEqual([{
      title: '系统架构',
      type: 'drawio',
      path: '03-交付物/系统架构.drawio',
      content: xml,
    }])
  })

  it('keeps mxfile examples embedded in normal prose as chat text', () => {
    const content = '可以使用下面的 XML：\n```xml\n<mxfile><diagram /></mxfile>\n```'
    const result = processStreamingContent(content)

    expect(result.cleanText).toBe(content)
    expect(result.completeArtifacts).toEqual([])
    expect(result.streamingArtifact).toBeNull()
  })
})
