import { describe, expect, it } from 'vitest'
import { ProviderRegistry, type CompletionRequest, type ModelProvider } from '../model'
import { SharedTaskTreeBudget } from '../engine/sub-agent/budget'
import type { QueryContext } from '../engine/types'
import { parsePptdArtifactContent } from './artifact'
import { createPptdModelCaller, generatePptdDeck, type PptdModelCall } from './pipeline'

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
  - elementId: title
    elementType: text
    bounds: [64, 48, 832, 64]
    content: { text: ${JSON.stringify(title)}, fontSize: 32, color: '$text', bold: true }
  - elementId: body
    elementType: text
    bounds: [64, 150, 832, 260]
    content: { text: '核心内容', fontSize: 20, color: '$text' }
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
    expect(pageCalls.every((call) => !call.prompt.includes('原始需求泄漏'))).toBe(true)
    expect(pageCalls[0].prompt).not.toContain('收入增长 20%')
    expect(pageCalls[1].prompt).not.toContain('本季度结论')
    expect(calls.filter((call) => call.stage === 'repair').map((call) => call.pageIndex)).toEqual([1])
  })

  it('falls back to a valid text page after two unsuccessful repair rounds', async () => {
    const result = await generatePptdDeck({ brief: '生成一页方案' }, {
      maxRepairRounds: 2,
      callModel: async (call) => {
        if (call.stage === 'design') return { text: DESIGN }
        if (call.stage === 'outline') {
          return { text: JSON.stringify({
            title: '方案', audience: '客户', goal: '确认方案', themeId: 'business-light',
            pages: [{ pageType: 'content', intent: '推荐方案 A', keyPoints: ['成本更低', '上线更快'] }],
          }) }
        }
        return { text: INVALID_PAGE }
      },
    })

    expect(result.pageReports[0]).toMatchObject({ status: 'fallback', attempts: 3 })
    expect(result.warnings[0]).toContain('已降级为纯文本页')
    expect(result.assembly.validation.valid).toBe(true)
    expect(result.project.pages[0].elements.map((element) => element.elementId)).toContain('fallback-note')
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
})

describe('PPTD QueryContext model adapter', () => {
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
    }, new AbortController().signal)

    expect(response.text).toBe('{"ok":true}')
    expect(requests[0]).toMatchObject({ model: 'mock-model', system: 'system', stream: true })
    expect(requests[0].tools).toBeUndefined()
    expect(budget.snapshot()).toMatchObject({ used: 0, byRun: {} })
  })
})
