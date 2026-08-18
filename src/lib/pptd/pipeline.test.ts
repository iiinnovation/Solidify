import { describe, expect, it } from 'vitest'
import { ProviderRegistry, type CompletionRequest, type ModelProvider } from '../model'
import { SharedTaskTreeBudget } from '../engine/sub-agent/budget'
import type { QueryContext } from '../engine/types'
import { parsePptdArtifactContent, parsePptdArtifactContentDetailed } from './artifact'
import { createPptdModelCaller, generatePptdDeck, runPptdDeckPipeline, type PptdModelCall } from './pipeline'

const OUTLINE = JSON.stringify({
  title: '经营复盘',
  audience: '管理层',
  goal: '确认下一季度重点',
  themeId: 'business-dark',
  pages: [
    { pageType: 'cover', intent: '经营复盘与下一步', keyPoints: ['本季度结论'] },
    { pageType: 'content', intent: '增长由核心客户驱动', keyPoints: ['收入增长 20%', '续约率提升'] },
  ],
})

const DESIGN = JSON.stringify({
  scenario: 'management-report',
  designSystemId: 'work/warm-jade-annual-report',
  visualSignature: '高密度经营汇报，以结论标题、细线网格和琥珀色重点形成审计感。',
  palette: {
    background: '#FBF9EE', surface: '#FFFFFF', text: '#181716',
    muted: '#6B625D', accent: '#FDC356', secondary: '#A09B93',
  },
  typography: { titleFont: 'Arial', bodyFont: 'Georgia', titleSize: 36, bodySize: 16 },
  layout: { margin: 48, columns: 12, gutter: 16 },
  compositionRules: ['标题先给结论', '证据按阅读顺序组织', '页面之间保持节奏变化'],
  componentRules: ['图表直接标注', '细线分组替代卡片', '来源固定在页脚'],
  prohibited: ['禁止卡片阵列', '禁止无依据装饰', '禁止虚构数据'],
  imageryStyle: '只使用与结论直接相关的真实图片。',
})

function validPage(title: string): string {
  return `pageType: content
elements:
  - elementId: accent
    elementType: shape
    bounds: [64, 140, 8, 250]
    shapeName: rect
    fill: { type: solid, color: '$accent' }
  - elementId: title
    elementType: text
    bounds: [64, 48, 832, 64]
    content: { text: ${JSON.stringify(title)}, fontSize: 32, color: '$text', bold: true }
  - elementId: body
    elementType: text
    bounds: [96, 150, 768, 72]
    content: { text: '核心内容', fontSize: 20, color: '$text' }
  - elementId: proof-a
    elementType: text
    bounds: [96, 250, 220, 60]
    content: { text: '证据 A', fontSize: 16, color: '$text' }
  - elementId: proof-b
    elementType: text
    bounds: [360, 250, 220, 60]
    content: { text: '证据 B', fontSize: 16, color: '$text' }
  - elementId: implication
    elementType: text
    bounds: [624, 250, 240, 60]
    content: { text: '结论含义', fontSize: 16, color: '$text' }
`
}

const INVALID_PAGE = `pageType: content
elements:
  - elementId: title
    elementType: text
    bounds: [900, 500, 200, 100]
    content: { text: 越界, fontSize: 32, color: '$text' }
`

describe('PPTD layered generation pipeline', () => {
  it('normalizes common model YAML boundary mistakes before validation', async () => {
    const arrayPage = `- elementId: title
  elementType: text
  bounds: [64, 48, 832, 64]
  content:
    text: "数组形式的页面"
    fontSize: 32
    color: '$text'
`
    const colonPage = `pageType: content
elements:
  - {elementId: accent, elementType: shape, bounds: [64, 140, 8, 250], shapeName: rect, fill: {type: solid, color: '$accent'}}
  - elementId: title
    elementType: text
    bounds: [64, 48, 832, 64]
    content:
      text: Synthesis: The PDF correction AI scenario
      fontSize: 32
      color: '$text'
  - {elementId: body, elementType: text, bounds: [96, 150, 768, 72], content: {text: "核心内容"}}
  - {elementId: proof-a, elementType: text, bounds: [96, 250, 220, 60], content: {text: "证据 A"}}
  - {elementId: proof-b, elementType: text, bounds: [360, 250, 220, 60], content: {text: "证据 B"}}
  - {elementId: implication, elementType: text, bounds: [624, 250, 240, 60], content: {text: "结论含义"}}
`
    const result = await generatePptdDeck({ brief: '修复模型页面格式' }, {
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '格式修复', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [
            { pageType: 'content', intent: '数组页面', keyPoints: ['页面'] },
            { pageType: 'content', intent: '冒号文本', keyPoints: ['页面'] },
          ],
        }) }
        return { text: call.pageIndex === 0 ? arrayPage : colonPage }
      },
    })

    expect(result.assembly.validation.valid).toBe(true)
    expect(result.project.pages[0].elements[0].content?.text).toBe('数组形式的页面')
    expect(result.project.pages[1].elements.find((element) => element.elementId === 'title')?.content?.text).toBe('Synthesis: The PDF correction AI scenario')
    expect(result.pageReports.map((page) => page.status)).toEqual(['generated', 'generated'])
  })

  it('accepts a conservatively wrapped page object without weakening element parsing', async () => {
    const wrappedPage = `page:
  pageType: content
  elements:
    - {elementId: accent, elementType: shape, bounds: [64, 140, 8, 250], shapeName: rect, fill: {type: solid, color: "$accent"}}
    - elementId: title
      elementType: text
      bounds: [64, 48, 832, 64]
      content: {text: "包裹页面", style: "$title"}
    - {elementId: body, elementType: text, bounds: [96, 150, 768, 72], content: {text: "核心内容"}}
    - {elementId: proof-a, elementType: text, bounds: [96, 250, 220, 60], content: {text: "证据 A"}}
    - {elementId: proof-b, elementType: text, bounds: [360, 250, 220, 60], content: {text: "证据 B"}}
    - {elementId: implication, elementType: text, bounds: [624, 250, 240, 60], content: {text: "结论含义"}}
`
    const result = await generatePptdDeck({ brief: '兼容包裹页面' }, {
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '包裹页面', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [{ pageType: 'content', intent: '包裹页面', keyPoints: ['标题'] }],
        }) }
        return { text: wrappedPage }
      },
    })

    expect(result.assembly.validation.valid).toBe(true)
    expect(result.project.pages[0].elements.some((element) => element.elementId === 'title')).toBe(true)
    expect(result.pageReports[0].status).toBe('generated')
  })

  it('batch-reviews rendered pages and repairs only pages reported by vision', async () => {
    const calls: PptdModelCall[] = []
    let reviewCalls = 0
    const result = await generatePptdDeck({ brief: '生成一页视觉复核方案' }, {
      visualReview: { visionAvailable: true, maxRounds: 2 },
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '视觉复核', audience: '客户', goal: '确认方案', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '推荐方案', keyPoints: ['证据'], layout: '主视觉加结论', visualTask: '建立清晰层级' }],
          }) }
        }
        if (call.stage === 'review') {
          reviewCalls++
          return reviewCalls === 1
            ? { text: JSON.stringify({ approved: false, pages: [{ pageIndex: 0, feedback: 'body 与 title 间距不足，请移动 body' }] }) }
            : { text: JSON.stringify({ approved: true, pages: [] }) }
        }
        if (call.stage === 'repair') return { text: validPage('视觉修复后的结论') }
        return { text: validPage('推荐方案') }
      },
    })

    expect(calls.filter((call) => call.stage === 'review')).toHaveLength(2)
    expect(calls.find((call) => call.stage === 'review')?.images?.[0]?.dataUrl).toMatch(/^data:image\/(?:png|svg\+xml)/)
    expect(calls.filter((call) => call.stage === 'repair')).toHaveLength(1)
    expect(result.pageReports[0]).toMatchObject({ status: 'repaired', attempts: 2 })
    expect(result.warnings.some((warning) => warning.includes('仍有问题'))).toBe(false)
  })

  it('records a deterministic skip instead of calling review on non-vision models', async () => {
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '生成一页方案' }, {
      visualReview: { visionAvailable: false },
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '方案', audience: '客户', goal: '确认', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '推荐方案', keyPoints: ['证据'] }],
          }) }
        }
        return { text: validPage('推荐方案') }
      },
    })

    expect(calls.some((call) => call.stage === 'review')).toBe(false)
    expect(result.warnings).toContain('当前模型不支持 vision，已跳过 PPTD 截图审阅，仅执行结构校验')
    expect(parsePptdArtifactContentDetailed(result.artifact.content).qualityReport?.notices)
      .toContain('当前模型不支持 vision，已跳过 PPTD 截图审阅，仅执行结构校验')
  })

  it('carries trusted media into visual calls, page prompts, previews, and the final bundle', async () => {
    const calls: PptdModelCall[] = []
    const previews: string[] = []
    const media = { 'media/quarterly-chart.png': 'data:image/png;base64,iVBORw0KGgo=' }
    const result = await generatePptdDeck({ brief: '使用上传图表生成汇报', media }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '图表汇报', audience: '管理层', goal: '解释趋势', themeId: 'data',
            pages: [{
              pageType: 'content', intent: '季度趋势正在改善', keyPoints: ['趋势改善'],
              layout: '左图右结论', visualTask: '上传图表作为主视觉', assetBrief: '季度图表',
            }],
          }) }
        }
        return { text: validPage('季度趋势正在改善') }
      },
      onProgress(progress) {
        if (progress.preview) previews.push(progress.preview.content)
      },
    })

    expect(calls.every((call) => call.images?.[0]?.path === 'media/quarterly-chart.png')).toBe(true)
    expect(calls.find((call) => call.stage === 'page')?.prompt).toContain('media/quarterly-chart.png')
    expect(calls.find((call) => call.stage === 'page')?.prompt).not.toContain('当前没有可用图片')
    expect(result.project.media).toEqual(media)
    expect(parsePptdArtifactContent(result.artifact.content)?.media).toEqual(media)
    expect(parsePptdArtifactContent(previews[0])?.media).toEqual(media)
  })

  it('retries invalid outline JSON, isolates page prompts, repairs only the failed page, and emits one slides bundle', async () => {
    const calls: PptdModelCall[] = []
    const progressEvents: Parameters<NonNullable<Parameters<typeof generatePptdDeck>[1]['onProgress']>>[0][] = []
    const previews: NonNullable<Parameters<NonNullable<Parameters<typeof generatePptdDeck>[1]['onProgress']>>[0]['preview']>[] = []
    let outlineCalls = 0
    const result = await generatePptdDeck({
      brief: '基于内部经营材料生成两页深色汇报，不要把原始需求泄漏到逐页调用。',
      materials: '收入和续约数据',
    }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: ++outlineCalls === 1 ? 'not json' : OUTLINE }
        if (call.stage === 'page') return { text: call.pageIndex === 0 ? validPage('经营复盘与下一步') : INVALID_PAGE }
        return { text: validPage('增长由核心客户驱动') }
      },
      onProgress: (progress) => {
        progressEvents.push(progress)
        if (progress.preview) previews.push(progress.preview)
      },
    })

    expect(result.project.pages).toHaveLength(2)
    expect(result.assembly.validation.valid).toBe(true)
    expect(result.pageReports.map((page) => page.status)).toEqual(['generated', 'repaired'])
    expect(result.usage.calls).toBe(6)
    expect(result.design.designSystemId).toBe('work/warm-jade-annual-report')
    expect(result.artifact.type).toBe('slides')
    expect(result.artifact.envelope.match(/<solidify-artifact/g)).toHaveLength(1)
    expect(parsePptdArtifactContent(result.artifact.content)?.pages).toHaveLength(2)
    expect(previews.length).toBeGreaterThanOrEqual(2)
    expect(previews.every((preview) => preview.pageCount === 2)).toBe(true)
    expect(parsePptdArtifactContent(previews[0].content)?.pages).toHaveLength(2)
    expect(previews.at(-1)?.content).toBe(result.artifact.content)
    expect(progressEvents.filter((event) => event.stage === 'page' && event.preview).map((event) => event.current))
      .toEqual([1, 2])

    const pageCalls = calls.filter((call) => call.stage === 'page')
    expect(pageCalls).toHaveLength(2)
    expect(pageCalls[0].prompt).toContain('Kimi PPTD')
    expect(pageCalls[0].prompt).toContain('<layout_reference_page>')
    expect(pageCalls[0].prompt).toContain('style: "$title"')
    expect(pageCalls[1].prompt).toContain('至少包含 6 个元素和至少 1 个非文本元素')
    expect(pageCalls[0].prompt).not.toContain('"scenario":"management-report"')
    expect(pageCalls[0].prompt).not.toContain('"designSystemId":"work/warm-jade-annual-report"')
    expect(pageCalls.every((call) => !call.prompt.includes('原始需求泄漏'))).toBe(true)
    expect(pageCalls[0].prompt).not.toContain('收入增长 20%')
    expect(pageCalls[1].prompt).not.toContain('本季度结论')
    expect(calls.filter((call) => call.stage === 'repair').map((call) => call.pageIndex)).toEqual([1])
    expect(calls.find((call) => call.stage === 'repair')?.prompt).toContain('<current_page_snapshot>')
    expect(calls.find((call) => call.stage === 'repair')?.prompt).not.toContain('<current_page>')
    expect(calls.find((call) => call.stage === 'repair')?.prompt).toContain('全部 elementId')
    expect(pageCalls.every((call) => call.maxTokens === 4_800)).toBe(true)
    expect(calls.find((call) => call.stage === 'repair')?.maxTokens).toBe(5_200)
  })

  it('falls back to the deterministic design when both design responses hit the output ceiling', async () => {
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '设计阶段输出过长时仍交付一页方案' }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') throw new Error('PPTD design 输出达到 token 上限')
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '方案', audience: '客户', goal: '确认', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '推荐方案', keyPoints: ['证据'] }],
          }) }
        }
        return { text: validPage('推荐方案') }
      },
    })

    expect(calls.filter((call) => call.stage === 'design')).toHaveLength(2)
    expect(calls.filter((call) => call.stage === 'design').every((call) => call.maxTokens === 4_000)).toBe(true)
    expect(result.design.designSystemId).toBe('work/warm-jade-annual-report')
    expect(result.warnings.some((warning) => warning.includes('确定性设计规范'))).toBe(true)
    expect(result.assembly.validation.valid).toBe(true)
  })

  it('falls back to a deterministic outline when both outline responses hit the output ceiling', async () => {
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '# 技术方案\n建设统一审计平台', maxPages: 3 }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') throw new Error('PPTD outline 输出达到 token 上限')
        return { text: validPage(call.pageIndex === 0 ? '技术方案' : `第 ${(call.pageIndex ?? 0) + 1} 页`) }
      },
    })

    expect(calls.filter((call) => call.stage === 'outline')).toHaveLength(2)
    expect(result.outline.pages).toHaveLength(3)
    expect(result.outline.title).toBe('技术方案')
    expect(result.warnings.some((warning) => warning.includes('确定性大纲'))).toBe(true)
    expect(result.assembly.validation.valid).toBe(true)
  })

  it('falls back instead of aborting when design and outline empty-output retries are exhausted', async () => {
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '# 空响应恢复\n生成可交付方案', maxPages: 2 }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design' || call.stage === 'outline') {
          throw new Error(`PPTD ${call.stage} 模型连续 2 次返回空内容`)
        }
        return { text: validPage(`第 ${(call.pageIndex ?? 0) + 1} 页`) }
      },
    })

    expect(calls.filter((call) => call.stage === 'design')).toHaveLength(1)
    expect(calls.filter((call) => call.stage === 'outline')).toHaveLength(1)
    expect(result.project.pages).toHaveLength(2)
    expect(result.warnings.some((warning) => warning.includes('确定性设计规范'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('确定性大纲'))).toBe(true)
    expect(result.assembly.validation.valid).toBe(true)
  })

  it('keeps a structurally valid deck when visual review returns empty content after retries', async () => {
    const result = await generatePptdDeck({ brief: '生成一页并容忍审阅空响应' }, {
      visualReview: { visionAvailable: true, maxRounds: 2 },
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '审阅恢复', audience: '客户', goal: '交付', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '方案结论', keyPoints: ['证据'] }],
          }) }
        }
        if (call.stage === 'review') throw new Error('PPTD review 模型连续 2 次返回空内容')
        return { text: validPage('方案结论') }
      },
    })

    expect(result.assembly.validation.valid).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('已保留结构合法版本'))).toBe(true)
  })

  it('delivers a visible deterministic fallback after repair exhaustion', async () => {
    let repairCalls = 0
    const progress: string[] = []
    const result = await generatePptdDeck({ brief: '生成一页方案' }, {
      maxRepairRounds: 2,
      onProgress(event) { progress.push(event.message) },
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '方案', audience: '客户', goal: '确认方案', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '推荐方案 A', keyPoints: ['成本更低', '上线更快'] }],
          }) }
        }
        if (call.stage === 'repair') repairCalls++
        return { text: INVALID_PAGE }
      },
    })

    expect(repairCalls).toBe(2)
    expect(progress).toContain('1 页已切换为安全版式，继续交付完整演示文稿')
    expect(result.pageReports[0]).toMatchObject({ status: 'fallback', attempts: 3 })
    expect(result.assembly.validation.valid).toBe(true)
    expect(result.warnings).toContain('1 页在 2 轮修复后使用安全版式：第 1 页')
    expect(parsePptdArtifactContentDetailed(result.artifact.content).qualityReport?.fallbackPages[0]).toMatchObject({
      pageIndex: 0,
      pagePath: 'pages/01.page',
    })
  })

  it('still fails the deck for a technical model transport error', async () => {
    await expect(generatePptdDeck({ brief: '生成一页方案' }, {
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '方案', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [{ pageType: 'content', intent: '结论', keyPoints: ['证据'] }],
        }) }
        throw new Error('network unavailable')
      },
    })).rejects.toThrow('network unavailable')
  })

  it('persists canonical checkpoints and reuses completed pages on retry', async () => {
    const files = new Map<string, string>()
    let firstCalls = 0
    const input = { brief: '可恢复的一页方案' }
    const first = await generatePptdDeck(input, {
      onCheckpoint: async ({ path, content }) => { files.set(path, content) },
      loadCheckpoint: async (path) => files.get(path),
      callModel: async (call) => {
        firstCalls++
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '检查点方案', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [{ pageType: 'content', intent: '检查点结论', keyPoints: ['证据'] }],
        }) }
        return { text: validPage('检查点结论') }
      },
    })
    expect(firstCalls).toBe(3)
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/deck\.pptd$/),
      expect.stringMatching(/\/pages\/01\.page$/),
    ]))

    let retryCalls = 0
    const retry = await generatePptdDeck(input, {
      onCheckpoint: async ({ path, content }) => { files.set(path, content) },
      loadCheckpoint: async (path) => files.get(path),
      callModel: async () => {
        retryCalls++
        throw new Error('checkpoint should avoid model calls')
      },
    })

    expect(retryCalls).toBe(0)
    expect(retry.project.pages).toEqual(first.project.pages)
    expect(retry.warnings).toContain('已从工作区检查点恢复视觉系统和大纲')
    expect(retry.warnings).toContain('已从工作区检查点恢复 1/1 页')
  })

  it('treats a checkpoint write failure as a technical failure', async () => {
    await expect(generatePptdDeck({ brief: '检查点写入失败' }, {
      onCheckpoint: async () => { throw new Error('disk full') },
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '方案', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [{ pageType: 'content', intent: '结论', keyPoints: ['证据'] }],
        }) }
        return { text: validPage('结论') }
      },
    })).rejects.toThrow('disk full')
  })

  it('keeps a valid warning-only page unchanged without spending repair calls', async () => {
    const warningPage = `pageType: cover
background: { color: '#111827' }
elements:
  - elementId: cover-title
    elementType: text
    bounds: [64, 180, 832, 80]
    content: { text: '经营复盘', fontSize: 9, color: '#FFFFFF', bold: true }
`
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '生成一页深色封面' }, {
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        return call.stage === 'outline'
          ? { text: JSON.stringify({
              title: '经营复盘', audience: '管理层', goal: '复盘', themeId: 'business-light',
              pages: [{ pageType: 'cover', intent: '经营复盘', keyPoints: ['季度结论'] }],
            }) }
          : { text: warningPage }
      },
    })

    expect(calls.filter((call) => call.stage === 'repair')).toHaveLength(0)
    expect(result.pageReports[0]).toMatchObject({ status: 'generated', attempts: 1 })
    expect(result.pageReports[0].diagnostics.map((item) => item.code)).toContain('small-font')
    expect(result.project.pages[0].background).toEqual({ color: '#111827' })
    expect(result.project.pages[0].elements.map((element) => element.elementId)).toEqual(['cover-title'])
    expect(result.warnings.some((warning) => warning.includes('已保留合法页面'))).toBe(true)
  })

  it('allows composition repairs to add and restructure elements', async () => {
    const sparsePage = `pageType: content
elements:
  - {elementId: title, elementType: text, bounds: [64, 48, 832, 64], content: {text: "结论"}}
  - {elementId: a, elementType: text, bounds: [64, 150, 240, 40], content: {text: "业务痛点识别"}}
  - {elementId: b, elementType: text, bounds: [360, 150, 240, 40], content: {text: "五大功能需求"}}
  - {elementId: c, elementType: text, bounds: [656, 150, 240, 40], content: {text: "性能与安全需求"}}
`
    const calls: PptdModelCall[] = []
    const result = await generatePptdDeck({ brief: '保留稀疏页面元素' }, {
      maxRepairRounds: 1,
      callModel: async (call) => {
        calls.push(call)
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: JSON.stringify({
          title: '稀疏页面', audience: '客户', goal: '交付', themeId: 'business-light',
          pages: [{ pageType: 'content', intent: '结论', keyPoints: ['业务痛点识别', '五大功能需求', '性能与安全需求'] }],
        }) }
        if (call.stage === 'repair') return { text: validPage('结论') }
        return { text: sparsePage }
      },
    })

    expect(calls.filter((call) => call.stage === 'repair')).toHaveLength(1)
    expect(calls.find((call) => call.stage === 'repair')?.prompt).toContain('允许并且必须新增、删除、重排元素')
    expect(result.project.pages[0].elements).toHaveLength(6)
    expect(result.project.pages[0].elements.some((element) => element.elementType !== 'text')).toBe(true)
    expect(result.pageReports[0].status).toBe('repaired')
    expect(result.artifact.content).not.toContain('页面只包含少量文本标签')
  })

  it('does not retain warnings produced by a rejected outline attempt', async () => {
    let outlineCalls = 0
    const invalidFirstAttempt = {
      title: '方案', audience: '客户', goal: '确认方案', themeId: 'business-light',
      pages: [
        { pageType: 'content', intent: '推荐方案', keyPoints: ['1', '2', '3', '4', '5', '6', '7'] },
        { pageType: 'content', intent: '下一步', keyPoints: [] },
      ],
    }
    const validSecondAttempt = {
      ...invalidFirstAttempt,
      pages: [{ pageType: 'content', intent: '推荐方案', keyPoints: ['1', '2', '3', '4', '5', '6', '7'] }],
    }
    const result = await generatePptdDeck({ brief: '生成方案' }, {
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify(++outlineCalls === 1 ? invalidFirstAttempt : validSecondAttempt) }
        }
        return { text: validPage('推荐方案') }
      },
    })

    expect(result.warnings.filter((warning) => warning.includes('keyPoints 已从 7 条截断'))).toHaveLength(1)
  })

  it('clips excessive outline pages and key points at the deterministic boundary', async () => {
    const pages = Array.from({ length: 4 }, (_, index) => ({
      pageType: 'content', intent: `结论 ${index + 1}`, keyPoints: ['1', '2', '3', '4', '5', '6', '7'],
    }))
    const result = await generatePptdDeck({ brief: '数据汇报', maxPages: 2 }, {
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        return call.stage === 'outline'
          ? { text: JSON.stringify({ title: '数据汇报', audience: '管理层', goal: '决策', themeId: 'unknown', pages }) }
          : { text: validPage('结论') }
      },
    })

    expect(result.outline.themeId).toBe('data')
    expect(result.outline.pages).toHaveLength(2)
    expect(result.outline.pages[0].keyPoints).toHaveLength(6)
    expect(result.warnings.some((warning) => warning.includes('截断为 2 页'))).toBe(true)
  })

  it('reports completed page count monotonically instead of the number of parallel workers started', async () => {
    const progress: Array<{ current: number; total: number; message: string }> = []
    let releaseFirstPage: (() => void) | undefined
    const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve })

    await generatePptdDeck({ brief: '生成两页汇报' }, {
      concurrency: 2,
      onProgress(event) {
        if (event.stage === 'page') progress.push(event)
      },
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') return { text: OUTLINE }
        if (call.stage === 'page' && call.pageIndex === 0) await firstPageGate
        if (call.stage === 'page' && call.pageIndex === 1) releaseFirstPage?.()
        return { text: validPage(`第 ${(call.pageIndex ?? 0) + 1} 页`) }
      },
    })

    expect(progress[0]).toMatchObject({ current: 0, total: 2 })
    expect(progress[0].message).toContain('并行生成 2 页')
    expect(progress.map((event) => event.current)).toEqual([0, 1, 2])
    expect(progress.at(-1)?.message).toContain('已完成 2/2 页')
  })

  it('throttles full deck previews while continuing to report every completed page', async () => {
    const pageProgress: Array<{ current: number; preview: boolean }> = []
    const pages = Array.from({ length: 8 }, (_, index) => ({
      pageType: 'content', intent: `结论 ${index + 1}`, keyPoints: [`证据 ${index + 1}`],
    }))

    await generatePptdDeck({ brief: '生成八页汇报' }, {
      concurrency: 1,
      onProgress(event) {
        if (event.stage === 'page' && event.current > 0) {
          pageProgress.push({ current: event.current, preview: Boolean(event.preview) })
        }
      },
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '八页汇报', audience: '管理层', goal: '决策', themeId: 'business-light', pages,
          }) }
        }
        return { text: validPage(`第 ${(call.pageIndex ?? 0) + 1} 页`) }
      },
    })

    expect(pageProgress.map((event) => event.current)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(pageProgress.filter((event) => event.preview).map((event) => event.current)).toEqual([1, 4, 8])
  })
})

describe('PPTD QueryContext model adapter', () => {
  it('enables one batch visual review in the production QueryContext pipeline', async () => {
    const requests: CompletionRequest[] = []
    const provider: ModelProvider = {
      name: 'production-vision',
      metadata: {
        name: 'production-vision', displayName: 'Production Vision', supportsVision: true, supportsTools: true,
        supportsStreaming: true, defaultMaxTokens: 8_192, models: ['vision-model'],
      },
      async *stream(request) {
        requests.push(request)
        let text: string
        if (request.system?.includes('艺术指导')) text = DESIGN
        else if (request.system?.includes('信息架构师')) text = OUTLINE
        else if (request.system?.includes('视觉质量审查器')) text = JSON.stringify({ approved: true, pages: [] })
        else text = validPage('生产页')
        yield { type: 'content_delta', delta: text }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }
    const registry = new ProviderRegistry()
    registry.register('production-vision', provider)
    const ctx = {
      runId: 'root', model: { provider: 'production-vision', model: 'vision-model' }, providerRegistry: registry,
      signal: new AbortController().signal,
    } as unknown as QueryContext

    const result = await runPptdDeckPipeline(ctx, { brief: '生产视觉管线' })
    const reviewRequests = requests.filter((request) => request.system?.includes('视觉质量审查器'))

    expect(result.project.pages).toHaveLength(2)
    expect(reviewRequests).toHaveLength(1)
    expect(reviewRequests[0].messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
    ]))
    expect(result.warnings.some((warning) => warning.includes('跳过 PPTD 截图审阅'))).toBe(false)
  })

  it('streams through the active provider without charging the generic Agent task budget', async () => {
    const requests: CompletionRequest[] = []
    const provider: ModelProvider = {
      name: 'mock',
      metadata: {
        name: 'mock', displayName: 'Mock', supportsVision: false, supportsTools: true,
        supportsStreaming: true, defaultMaxTokens: 4096, models: ['mock-model'],
      },
      async *stream(request) {
        requests.push(request)
        yield { type: 'content_delta', delta: '{"ok":true}' }
        yield { type: 'message_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: 'end_turn' }
      },
    }
    const registry = new ProviderRegistry()
    registry.register('mock', provider)
    const budget = new SharedTaskTreeBudget(100)
    const ctx = {
      runId: 'root', model: { provider: 'mock', model: 'mock-model' }, providerRegistry: registry,
      limits: { maxTokens: 100 }, taskTree: { rootRunId: 'root', depth: 0, budget },
    } as unknown as QueryContext

    const response = await createPptdModelCaller(ctx)({
      stage: 'outline', runId: 'pptd:outline:1', system: 'system', prompt: 'prompt', maxTokens: 100,
      images: [{ path: 'media/chart.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    }, new AbortController().signal)

    expect(response.text).toBe('{"ok":true}')
    expect(requests[0]).toMatchObject({ model: 'mock-model', system: 'system', stream: true })
    expect(requests[0].messages[0].content).toBe('prompt')
    expect(requests[0].tools).toBeUndefined()
    expect(budget.snapshot()).toMatchObject({ used: 0, byRun: {} })
  })

  it('retries an empty provider stream once and includes both attempts in usage', async () => {
    const requests: CompletionRequest[] = []
    const provider: ModelProvider = {
      name: 'empty-once',
      metadata: {
        name: 'empty-once', displayName: 'Empty Once', supportsVision: false, supportsTools: true,
        supportsStreaming: true, defaultMaxTokens: 4096, models: ['empty-once-model'],
      },
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: 'message_end', usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 }, stopReason: 'end_turn' }
          return
        }
        yield { type: 'content_delta', delta: '{"ok":true}' }
        yield { type: 'message_end', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, stopReason: 'end_turn' }
      },
    }
    const registry = new ProviderRegistry()
    registry.register('empty-once', provider)
    const ctx = {
      runId: 'root', model: { provider: 'empty-once', model: 'empty-once-model' }, providerRegistry: registry,
    } as unknown as QueryContext

    const response = await createPptdModelCaller(ctx)({
      stage: 'outline', runId: 'pptd:outline:1', system: 'system', prompt: 'prompt', maxTokens: 100,
    }, new AbortController().signal)

    expect(requests).toHaveLength(2)
    expect(response).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
    })
  })

  it('caps empty-output retries and does not retry max-token responses', async () => {
    let emptyRequests = 0
    const emptyProvider: ModelProvider = {
      name: 'always-empty',
      metadata: {
        name: 'always-empty', displayName: 'Always Empty', supportsVision: false, supportsTools: true,
        supportsStreaming: true, defaultMaxTokens: 4096, models: ['always-empty-model'],
      },
      async *stream() {
        emptyRequests++
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }
    const emptyRegistry = new ProviderRegistry()
    emptyRegistry.register('always-empty', emptyProvider)
    const emptyCtx = {
      runId: 'root', model: { provider: 'always-empty', model: 'always-empty-model' }, providerRegistry: emptyRegistry,
    } as unknown as QueryContext
    const request: PptdModelCall = {
      stage: 'page', runId: 'pptd:page:1', system: 'system', prompt: 'prompt', maxTokens: 100,
    }

    await expect(createPptdModelCaller(emptyCtx)(request, new AbortController().signal))
      .rejects.toThrow('连续 2 次返回空内容')
    expect(emptyRequests).toBe(2)

    let limitedRequests = 0
    const limitedProvider: ModelProvider = {
      ...emptyProvider,
      name: 'limited',
      metadata: { ...emptyProvider.metadata, name: 'limited', models: ['limited-model'] },
      async *stream() {
        limitedRequests++
        yield { type: 'message_end', stopReason: 'max_tokens' }
      },
    }
    const limitedRegistry = new ProviderRegistry()
    limitedRegistry.register('limited', limitedProvider)
    const limitedCtx = {
      runId: 'root', model: { provider: 'limited', model: 'limited-model' }, providerRegistry: limitedRegistry,
    } as unknown as QueryContext

    await expect(createPptdModelCaller(limitedCtx)(request, new AbortController().signal))
      .rejects.toThrow('输出达到 token 上限')
    expect(limitedRequests).toBe(1)
  })

  it('sends data URL image blocks only to a vision-capable provider', async () => {
    const requests: CompletionRequest[] = []
    const provider: ModelProvider = {
      name: 'vision',
      metadata: {
        name: 'vision', displayName: 'Vision', supportsVision: true, supportsTools: true,
        supportsStreaming: true, defaultMaxTokens: 4096, models: ['vision-model'],
      },
      async *stream(request) {
        requests.push(request)
        yield { type: 'content_delta', delta: 'ok' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }
    const registry = new ProviderRegistry()
    registry.register('vision', provider)
    const ctx = {
      runId: 'root', model: { provider: 'vision', model: 'vision-model' }, providerRegistry: registry,
    } as unknown as QueryContext

    await createPptdModelCaller(ctx)({
      stage: 'page', runId: 'pptd:page:1', system: 'system', prompt: 'compose', maxTokens: 100,
      images: [{ path: 'media/chart.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    }, new AbortController().signal)

    expect(requests[0].messages[0].content).toEqual([
      { type: 'text', text: 'compose' },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' },
    ])
  })
})
