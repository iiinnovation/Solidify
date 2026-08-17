import type { CompletionRequest, TokenUsage, UnifiedMessage } from '../model'
import { estimateTokens } from '../engine/context-budget'
import { SubAgentScheduler, type ScheduledResult } from '../engine/sub-agent/scheduler'
import type { QueryContext } from '../engine/types'
import { assemblePptdProject, type PptdAssemblyResult } from './assemble'
import { serializePptdArtifactContent } from './artifact'
import {
  fallbackPptdDesignSpec,
  resolvePptdDesignSource,
  themeFromDesignSpec,
  type PptdDesignSource,
  type PptdDesignSpec,
} from './design-resources'
import { parsePptdPage } from './parse'
import {
  getPptdThemePreset,
  inferPptdThemeId,
  isPptdThemeId,
  PPTD_THEME_IDS,
  type PptdThemeId,
} from './theme-presets'
import type { PptdDiagnostic, PptdPage, PptdProject } from './types'

const MAX_OUTLINE_ATTEMPTS = 2
const MAX_DESIGN_ATTEMPTS = 2
const MAX_REPAIR_ROUNDS = 2
const MAX_PIPELINE_CONCURRENCY = 5
const DEFAULT_MAX_PAGES = 24
const MAX_KEY_POINTS = 6
const MAX_MATERIAL_CHARS = 48_000
const PROGRESS_HEARTBEAT_MS = 10_000
export interface DeckOutlinePage {
  pageType: string
  intent: string
  keyPoints: string[]
  dataHint?: string
  layout?: string
  visualTask?: string
  assetBrief?: string
}

export interface DeckOutline {
  title: string
  audience: string
  goal: string
  themeId: PptdThemeId
  pages: DeckOutlinePage[]
}

export interface PptdDeckPipelineInput {
  brief: string
  materials?: string
  title?: string
  themeId?: PptdThemeId
  designSystemId?: string
  maxPages?: number
  artifactPath?: string
}

export type PptdPipelineStage = 'design' | 'outline' | 'page' | 'repair'

export interface PptdModelCall {
  stage: PptdPipelineStage
  runId: string
  system: string
  prompt: string
  maxTokens: number
  pageIndex?: number
}

export interface PptdModelCallResult {
  text: string
  usage?: TokenUsage
}

export type PptdModelCaller = (request: PptdModelCall, signal: AbortSignal) => Promise<PptdModelCallResult>

export interface PptdPipelineProgress {
  stage: PptdPipelineStage | 'assemble'
  current: number
  total: number
  pageIndex?: number
  message: string
  preview?: PptdDeckPreview
}

export interface PptdDeckPreview {
  title: string
  type: 'slides'
  path: string
  content: string
  pageCount: number
}

export interface PptdPageGenerationReport {
  pageIndex: number
  pagePath: string
  status: 'generated' | 'repaired' | 'fallback'
  attempts: number
  diagnostics: PptdDiagnostic[]
}

export interface PptdDeckPipelineUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
}

export interface PptdDeckArtifact {
  title: string
  type: 'slides'
  path: string
  content: string
  envelope: string
}

export interface PptdDeckPipelineResult {
  design: PptdDesignSpec
  outline: DeckOutline
  project: PptdProject
  assembly: PptdAssemblyResult
  artifact: PptdDeckArtifact
  pageReports: PptdPageGenerationReport[]
  warnings: string[]
  usage: PptdDeckPipelineUsage
}

export interface GeneratePptdDeckOptions {
  callModel: PptdModelCaller
  signal?: AbortSignal
  concurrency?: number
  maxRepairRounds?: number
  onProgress?: (progress: PptdPipelineProgress) => void
}

export interface RunPptdDeckPipelineOptions extends Omit<GeneratePptdDeckOptions, 'callModel' | 'signal'> {
  signal?: AbortSignal
}

interface PageState {
  pageIndex: number
  pagePath: string
  outline: DeckOutlinePage
  raw: string
  page: PptdPage
  parseError?: PptdDiagnostic
  attempts: number
  repaired: boolean
  fallback: boolean
  diagnostics: PptdDiagnostic[]
}

interface RepairTarget {
  state: PageState
}

/**
 * Runs the complete bounded generation pipeline with an injected model caller.
 * Only outline, page generation and targeted repair call the model.
 */
export async function generatePptdDeck(
  input: PptdDeckPipelineInput,
  options: GeneratePptdDeckOptions,
): Promise<PptdDeckPipelineResult> {
  const brief = input.brief.trim()
  if (!brief) throw new Error('PPTD 生成 brief 不能为空')
  const signal = options.signal ?? new AbortController().signal
  const concurrency = boundedInteger(options.concurrency ?? MAX_PIPELINE_CONCURRENCY, 1, MAX_PIPELINE_CONCURRENCY, 'concurrency')
  const maxRepairRounds = boundedInteger(options.maxRepairRounds ?? MAX_REPAIR_ROUNDS, 0, MAX_REPAIR_ROUNDS, 'maxRepairRounds')
  const maxPages = boundedInteger(input.maxPages ?? DEFAULT_MAX_PAGES, 1, DEFAULT_MAX_PAGES, 'maxPages')
  const usage: PptdDeckPipelineUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }
  const warnings: string[] = []

  const callModel = async (request: PptdModelCall): Promise<PptdModelCallResult> => {
    throwIfAborted(signal)
    const result = await options.callModel(request, signal)
    const measured = result.usage ?? estimateUsage(request, result.text)
    usage.inputTokens += measured.inputTokens
    usage.outputTokens += measured.outputTokens
    usage.totalTokens += measured.totalTokens ?? measured.inputTokens + measured.outputTokens
    usage.calls++
    return result
  }

  const designSource = resolvePptdDesignSource(`${input.brief}\n${input.materials ?? ''}`, input.designSystemId)
  const baseThemeId = input.themeId ?? inferPptdThemeId(`${input.brief}\n${input.materials ?? ''}`)
  const baseTheme = getPptdThemePreset(baseThemeId)
  const design = await generateDesignSpec(input, designSource, baseTheme, callModel, signal, warnings, options.onProgress)
  const outline = await generateOutline(input, design, maxPages, callModel, signal, warnings, options.onProgress)
  const theme = themeFromDesignSpec(getPptdThemePreset(outline.themeId), design)
  const scheduler = new SubAgentScheduler(concurrency)
  const previewStates = outline.pages.map((page, pageIndex) => pendingPreviewState(page, pageIndex, theme))
  let hasGeneratedPreviewPage = false
  let startedPages = 0
  let completedPages = 0
  const pageStartedAt = Date.now()
  const reportPageProgress = (message: string, pageIndex?: number) => options.onProgress?.({
    stage: 'page', current: completedPages, total: outline.pages.length, pageIndex, message,
  })
  reportPageProgress(`正在并行生成 ${outline.pages.length} 页（最多 ${Math.min(concurrency, outline.pages.length)} 页同时）`)
  const pageHeartbeat = startProgressHeartbeat(() => {
    const active = Math.max(0, startedPages - completedPages)
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - pageStartedAt) / 1_000))
    reportPageProgress(`已完成 ${completedPages}/${outline.pages.length} 页，${active} 页处理中（已运行 ${elapsedSeconds} 秒）`)
  })
  let generated: Array<ScheduledResult<PageState>>
  try {
    generated = await scheduler.run(outline.pages, async (pageOutline, pageIndex) => {
      startedPages++
      try {
        const pagePath = pagePathFor(pageIndex)
        const result = await callModel({
          stage: 'page',
          runId: `pptd:page:${pageIndex + 1}`,
          system: PAGE_SYSTEM_PROMPT,
          prompt: buildPagePrompt(outline, pageOutline, pageIndex, theme, design),
          maxTokens: 1_800,
          pageIndex,
        })
        const state = parsePageState(result.text, pageOutline, pageIndex, pagePath, theme)
        previewStates[pageIndex] = state
        hasGeneratedPreviewPage = true
        return state
      } finally {
        completedPages++
        const progress: PptdPipelineProgress = {
          stage: 'page', current: completedPages, total: outline.pages.length, pageIndex,
          message: `已完成 ${completedPages}/${outline.pages.length} 页`,
        }
        if (hasGeneratedPreviewPage) {
          const previewAssembly = assembleStates(outline.title, theme, previewStates)
          publishPreview(options.onProgress, input, outline, previewAssembly.project, progress)
        } else {
          options.onProgress?.(progress)
        }
      }
    }, signal)
  } finally {
    clearInterval(pageHeartbeat)
  }
  throwIfAborted(signal)

  const states = generated.map((entry, pageIndex): PageState => {
    if (entry.status === 'fulfilled') return entry.value
    const pagePath = pagePathFor(pageIndex)
    const diagnostic = pageDiagnostic(pagePath, `页面生成调用失败：${errorMessage(entry.reason)}`, 'generation-failed')
    return {
      pageIndex,
      pagePath,
      outline: outline.pages[pageIndex],
      raw: '',
      page: fallbackPage(outline.pages[pageIndex], theme, '页面生成失败，已暂用文本版'),
      parseError: diagnostic,
      attempts: 1,
      repaired: false,
      fallback: false,
      diagnostics: [diagnostic],
    }
  })

  let assembly = assembleStates(outline.title, theme, states)
  assertNoProjectErrors(assembly)
  publishPreview(options.onProgress, input, outline, assembly.project, {
    stage: 'assemble', current: 1, total: 1, message: '已装配 PPTD 工程，正在校验和修复',
  })

  for (let round = 1; round <= maxRepairRounds; round++) {
    const targets = repairTargets(states, assembly)
    if (targets.length === 0) break
    let completedRepairs = 0
    const repairStartedAt = Date.now()
    const reportRepairProgress = (message: string, pageIndex?: number) => options.onProgress?.({
      stage: 'repair', current: completedRepairs, total: targets.length, pageIndex, message,
    })
    reportRepairProgress(`第 ${round}/${maxRepairRounds} 轮修复：共 ${targets.length} 页`)
    const repairHeartbeat = startProgressHeartbeat(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - repairStartedAt) / 1_000))
      reportRepairProgress(`第 ${round}/${maxRepairRounds} 轮修复：已完成 ${completedRepairs}/${targets.length} 页（已运行 ${elapsedSeconds} 秒）`)
    })
    let repaired: Array<ScheduledResult<PageState>>
    try {
      repaired = await scheduler.run(targets, async (target) => {
        try {
          const diagnostics = diagnosticsForState(target.state, assembly)
          target.state.diagnostics.push(...diagnostics)
          const result = await callModel({
            stage: 'repair',
            runId: `pptd:repair:${target.state.pageIndex + 1}:${round}`,
            system: PAGE_SYSTEM_PROMPT,
            prompt: buildRepairPrompt(outline, target.state, diagnostics, theme, design),
            maxTokens: 1_800,
            pageIndex: target.state.pageIndex,
          })
          return parsePageState(
            result.text,
            target.state.outline,
            target.state.pageIndex,
            target.state.pagePath,
            theme,
            target.state,
          )
        } finally {
          completedRepairs++
          reportRepairProgress(`第 ${round}/${maxRepairRounds} 轮修复：已完成 ${completedRepairs}/${targets.length} 页`, target.state.pageIndex)
        }
      }, signal)
    } finally {
      clearInterval(repairHeartbeat)
    }
    throwIfAborted(signal)
    repaired.forEach((entry, index) => {
      const target = targets[index]
      if (entry.status === 'fulfilled') {
        states[target.state.pageIndex] = entry.value
      } else {
        target.state.attempts++
        target.state.diagnostics.push(pageDiagnostic(target.state.pagePath, `页面修复调用失败：${errorMessage(entry.reason)}`, 'repair-failed'))
      }
    })
    assembly = assembleStates(outline.title, theme, states)
    assertNoProjectErrors(assembly)
    publishPreview(options.onProgress, input, outline, assembly.project, {
      stage: 'repair',
      current: completedRepairs,
      total: targets.length,
      message: `第 ${round}/${maxRepairRounds} 轮修复结果已更新`,
    })
  }

  const unresolved = repairTargets(states, assembly)
  const requiredFallbacks = unresolved.map((target) => target.state)
  for (const state of requiredFallbacks) {
    state.diagnostics.push(...diagnosticsForState(state, assembly))
    state.page = fallbackPage(state.outline, theme, '自动排版未通过校验，已降级为纯文本页')
    state.parseError = undefined
    state.fallback = true
  }
  if (requiredFallbacks.length > 0) {
    warnings.push(`${requiredFallbacks.length} 页在 ${maxRepairRounds} 轮修复后仍未通过，已降级为纯文本页`)
    assembly = assembleStates(outline.title, theme, states)
    assertNoProjectErrors(assembly)
    publishPreview(options.onProgress, input, outline, assembly.project, {
      stage: 'repair',
      current: requiredFallbacks.length,
      total: requiredFallbacks.length,
      message: '已更新降级页面预览',
    })
  }
  if (!assembly.validation.valid) {
    throw new Error(`PPTD 最终装配仍未通过校验：${formatDiagnostics(assembly.validation.errors)}`)
  }

  const warningPages = new Set<number>()
  states.forEach((state) => {
    const pageWarnings = assembly.pageResults[state.pageIndex]?.warnings ?? []
    if (pageWarnings.length > 0) warningPages.add(state.pageIndex)
    state.diagnostics.push(...pageWarnings)
  })
  if (warningPages.size > 0) {
    warnings.push(`${warningPages.size} 页存在非阻塞 warning，已保留合法页面并记录诊断`)
  }
  if (assembly.projectWarnings.length > 0) {
    warnings.push(`PPTD 工程存在 ${assembly.projectWarnings.length} 条非阻塞 warning：${formatDiagnostics(assembly.projectWarnings)}`)
  }

  const artifact = createDeckArtifact(input, outline, assembly.project)
  const pageReports = states.map((state) => ({
    pageIndex: state.pageIndex,
    pagePath: state.pagePath,
    status: state.fallback ? 'fallback' as const : state.repaired ? 'repaired' as const : 'generated' as const,
    attempts: state.attempts,
    diagnostics: dedupeDiagnostics(state.diagnostics),
  }))
  return { design, outline, project: assembly.project, assembly, artifact, pageReports, warnings, usage }
}

function publishPreview(
  onProgress: GeneratePptdDeckOptions['onProgress'],
  input: PptdDeckPipelineInput,
  outline: DeckOutline,
  project: PptdProject,
  progress: Omit<PptdPipelineProgress, 'preview'>,
): void {
  if (!onProgress) return
  const artifact = createDeckArtifact(input, outline, project)
  onProgress({
    ...progress,
    preview: {
      title: artifact.title,
      type: artifact.type,
      path: artifact.path,
      content: artifact.content,
      pageCount: project.pages.length,
    },
  })
}

function createDeckArtifact(
  input: PptdDeckPipelineInput,
  outline: DeckOutline,
  project: PptdProject,
): PptdDeckArtifact {
  const content = serializePptdArtifactContent(project)
  const title = input.title?.trim() || outline.title
  const path = safeArtifactPath(input.artifactPath)
  return {
    title,
    type: 'slides',
    path,
    content,
    envelope: `<solidify-artifact title="${escapeAttribute(title)}" type="slides" path="${escapeAttribute(path)}">${content}</solidify-artifact>`,
  }
}

/** Uses the active QueryContext provider inside the pipeline's bounded stages. */
export function runPptdDeckPipeline(
  ctx: QueryContext,
  input: PptdDeckPipelineInput,
  options: RunPptdDeckPipelineOptions = {},
): Promise<PptdDeckPipelineResult> {
  const signal = options.signal ?? ctx.signal
  return generatePptdDeck(input, {
    ...options,
    signal,
    callModel: createPptdModelCaller(ctx),
  })
}

/** Adapts the existing streaming provider interface to one bounded pipeline call. */
export function createPptdModelCaller(ctx: QueryContext): PptdModelCaller {
  const provider = ctx.providerRegistry.get(ctx.model.provider)
  return async (request, signal) => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: request.prompt }]
    const completion: CompletionRequest = {
      model: ctx.model.model,
      system: request.system,
      messages,
      temperature: request.stage === 'outline' ? 0.2 : request.stage === 'design' ? 0.5 : 0.4,
      maxTokens: request.maxTokens,
      stream: true,
      signal,
    }
    let text = ''
    let usage: TokenUsage | undefined
    let stopReason: string | undefined
    for await (const chunk of provider.stream(completion)) {
      if (chunk.type === 'content_delta') text += chunk.delta
      else if (chunk.type === 'message_end') {
        usage = chunk.usage
        stopReason = chunk.stopReason
      } else if (chunk.type === 'error') {
        if (!chunk.error.recoverable) throw new Error(`PPTD 模型调用失败：${chunk.error.message}`)
      } else if (chunk.type === 'tool_call_start' || chunk.type === 'tool_call_delta' || chunk.type === 'tool_call_end') {
        throw new Error('PPTD 管线不接受模型工具调用')
      }
    }
    if (stopReason === 'max_tokens') throw new Error(`PPTD ${request.stage} 输出达到 token 上限`)
    if (!text.trim()) throw new Error(`PPTD ${request.stage} 模型返回空内容`)
    const measured = usage ?? estimateUsage(request, text)
    return { text, usage: measured }
  }
}

async function generateOutline(
  input: PptdDeckPipelineInput,
  design: PptdDesignSpec,
  maxPages: number,
  callModel: (request: PptdModelCall) => Promise<PptdModelCallResult>,
  signal: AbortSignal,
  warnings: string[],
  onProgress?: (progress: PptdPipelineProgress) => void,
): Promise<DeckOutline> {
  let parseFailure = ''
  for (let attempt = 1; attempt <= MAX_OUTLINE_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    onProgress?.({ stage: 'outline', current: attempt, total: MAX_OUTLINE_ATTEMPTS, message: attempt === 1 ? '生成演示文稿大纲' : '修正大纲结构' })
    const result = await callModel({
      stage: 'outline',
      runId: `pptd:outline:${attempt}`,
      system: OUTLINE_SYSTEM_PROMPT,
      prompt: buildOutlinePrompt(input, design, maxPages, parseFailure),
      maxTokens: 1_800,
    })
    try {
      const attemptWarnings: string[] = []
      const outline = normalizeOutline(parseJsonObject(result.text), input, maxPages, attemptWarnings)
      warnings.push(...attemptWarnings)
      return outline
    } catch (error) {
      parseFailure = errorMessage(error)
    }
  }
  throw new Error(`PPTD 大纲在 ${MAX_OUTLINE_ATTEMPTS} 次尝试后仍无效：${parseFailure}`)
}

async function generateDesignSpec(
  input: PptdDeckPipelineInput,
  source: PptdDesignSource,
  baseTheme: ReturnType<typeof getPptdThemePreset>,
  callModel: (request: PptdModelCall) => Promise<PptdModelCallResult>,
  signal: AbortSignal,
  warnings: string[],
  onProgress?: (progress: PptdPipelineProgress) => void,
): Promise<PptdDesignSpec> {
  let parseFailure = ''
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    onProgress?.({
      stage: 'design', current: attempt, total: MAX_DESIGN_ATTEMPTS,
      message: attempt === 1 ? `制定视觉系统：${source.designSystemId}` : '修正视觉系统结构',
    })
    const result = await callModel({
      stage: 'design',
      runId: `pptd:design:${attempt}`,
      system: DESIGN_SYSTEM_PROMPT,
      prompt: buildDesignPrompt(input, source, baseTheme, parseFailure),
      maxTokens: 2_400,
    })
    try {
      return normalizeDesignSpec(parseJsonObject(result.text), source, baseTheme)
    } catch (error) {
      parseFailure = errorMessage(error)
    }
  }
  warnings.push(`视觉系统在 ${MAX_DESIGN_ATTEMPTS} 次尝试后仍无效，已使用确定性设计规范：${parseFailure}`)
  return fallbackPptdDesignSpec(source, baseTheme)
}

function buildDesignPrompt(
  input: PptdDeckPipelineInput,
  source: PptdDesignSource,
  baseTheme: ReturnType<typeof getPptdThemePreset>,
  correction: string,
): string {
  return [
    '请把参考设计方法压缩为本次演示文稿专用的视觉系统。只返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释。',
    '参考样页只用于学习构图密度、层级和节奏，绝对不要复制其中的产品名称、数据、链接或事实。',
    `scenario 和 designSystemId 必须分别为 ${source.scenario} 与 ${source.designSystemId}。`,
    '所有颜色必须是 #RRGGBB；字号、边距、列数和间距必须是数字。compositionRules/componentRules/prohibited 各 3-8 条。',
    'JSON 结构：{"scenario":"...","designSystemId":"...","visualSignature":"...","palette":{"background":"#...","surface":"#...","text":"#...","muted":"#...","accent":"#...","secondary":"#..."},"typography":{"titleFont":"...","bodyFont":"...","titleSize":32,"bodySize":18},"layout":{"margin":48,"columns":12,"gutter":16},"compositionRules":["..."],"componentRules":["..."],"prohibited":["..."],"imageryStyle":"..."}',
    correction ? `上一次输出无效：${correction}。请严格修正结构。` : '',
    `<base_theme>\n${JSON.stringify(baseTheme)}\n</base_theme>`,
    `<brief>\n${input.brief.trim()}\n</brief>`,
    `<general_guidance>\n${clipDesignResource(source.generalGuidance, 6_000)}\n</general_guidance>`,
    `<scenario_guidance>\n${clipDesignResource(source.scenarioGuidance, 12_000)}\n</scenario_guidance>`,
    `<design_system>\n${clipDesignResource(source.designGuidance, 16_000)}\n</design_system>`,
    source.examplePage ? `<reference_page>\n${clipDesignResource(source.examplePage, 10_000)}\n</reference_page>` : '',
  ].filter(Boolean).join('\n\n')
}

function normalizeDesignSpec(
  value: Record<string, unknown>,
  source: PptdDesignSource,
  baseTheme: ReturnType<typeof getPptdThemePreset>,
): PptdDesignSpec {
  const fallback = fallbackPptdDesignSpec(source, baseTheme)
  const palette = recordField(value.palette, 'palette')
  const typography = recordField(value.typography, 'typography')
  const layout = recordField(value.layout, 'layout')
  return {
    scenario: source.scenario,
    designSystemId: source.designSystemId,
    visualSignature: nonEmptyString(value.visualSignature, 'visualSignature'),
    palette: {
      background: hexColor(palette.background, 'palette.background'),
      surface: hexColor(palette.surface, 'palette.surface'),
      text: hexColor(palette.text, 'palette.text'),
      muted: hexColor(palette.muted, 'palette.muted'),
      accent: hexColor(palette.accent, 'palette.accent'),
      secondary: hexColor(palette.secondary, 'palette.secondary'),
    },
    typography: {
      titleFont: nonEmptyString(typography.titleFont, 'typography.titleFont'),
      bodyFont: nonEmptyString(typography.bodyFont, 'typography.bodyFont'),
      titleSize: boundedNumber(typography.titleSize, 26, 54, 'typography.titleSize'),
      bodySize: boundedNumber(typography.bodySize, 12, 24, 'typography.bodySize'),
    },
    layout: {
      margin: boundedNumber(layout.margin, 32, 96, 'layout.margin'),
      columns: boundedIntegerValue(layout.columns, 4, 16, 'layout.columns'),
      gutter: boundedNumber(layout.gutter, 8, 32, 'layout.gutter'),
    },
    compositionRules: stringArray(value.compositionRules, 'compositionRules', 3, 8),
    componentRules: stringArray(value.componentRules, 'componentRules', 3, 8),
    prohibited: stringArray(value.prohibited, 'prohibited', 3, 8),
    imageryStyle: typeof value.imageryStyle === 'string' && value.imageryStyle.trim()
      ? value.imageryStyle.trim()
      : fallback.imageryStyle,
  }
}

function parsePageState(
  raw: string,
  outline: DeckOutlinePage,
  pageIndex: number,
  pagePath: string,
  theme: ReturnType<typeof getPptdThemePreset>,
  previous?: PageState,
): PageState {
  const attempts = (previous?.attempts ?? 0) + 1
  try {
    return {
      pageIndex, pagePath, outline, raw, page: parsePptdPage(stripCodeFence(raw), pagePath, theme),
      attempts, repaired: Boolean(previous), fallback: false,
      diagnostics: [...(previous?.diagnostics ?? [])],
    }
  } catch (error) {
    const diagnostic = pageDiagnostic(pagePath, `页面 YAML 无法解析：${errorMessage(error)}`, 'page-parse-error')
    return {
      pageIndex, pagePath, outline, raw,
      page: previous?.page ?? fallbackPage(outline, theme, '页面 YAML 无法解析，等待自动修复'),
      parseError: diagnostic,
      attempts,
      repaired: Boolean(previous),
      fallback: false,
      diagnostics: [...(previous?.diagnostics ?? []), diagnostic],
    }
  }
}

function assembleStates(title: string, theme: ReturnType<typeof getPptdThemePreset>, states: readonly PageState[]): PptdAssemblyResult {
  return assemblePptdProject({
    title,
    theme,
    pages: states.map((state) => state.page),
    pagePaths: states.map((state) => state.pagePath),
  })
}

function repairTargets(states: PageState[], assembly: PptdAssemblyResult): RepairTarget[] {
  return states.flatMap((state) => {
    const validation = assembly.pageResults[state.pageIndex]
    return state.parseError || !validation?.valid ? [{ state }] : []
  })
}

function diagnosticsForState(state: PageState, assembly: PptdAssemblyResult): PptdDiagnostic[] {
  const validation = assembly.pageResults[state.pageIndex]
  return dedupeDiagnostics([
    ...(state.parseError ? [state.parseError] : []),
    ...(validation?.errors ?? []),
  ])
}

function assertNoProjectErrors(assembly: PptdAssemblyResult): void {
  if (assembly.projectErrors.length === 0) return
  throw new Error(`PPTD 项目级校验失败：${formatDiagnostics(assembly.projectErrors)}`)
}

function normalizeOutline(value: Record<string, unknown>, input: PptdDeckPipelineInput, maxPages: number, warnings: string[]): DeckOutline {
  const title = nonEmptyString(value.title, 'title')
  const audience = nonEmptyString(value.audience, 'audience')
  const goal = nonEmptyString(value.goal, 'goal')
  const rawPages = Array.isArray(value.pages) ? value.pages : undefined
  if (!rawPages?.length) throw new Error('pages 必须是非空数组')
  const pages = rawPages.map((raw, index): DeckOutlinePage => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`pages[${index}] 必须是对象`)
    const page = raw as Record<string, unknown>
    const points = Array.isArray(page.keyPoints) ? page.keyPoints : undefined
    if (!points?.length || points.some((point) => typeof point !== 'string' || !point.trim())) {
      throw new Error(`pages[${index}].keyPoints 必须是非空字符串数组`)
    }
    if (points.length > MAX_KEY_POINTS) warnings.push(`第 ${index + 1} 页 keyPoints 已从 ${points.length} 条截断为 ${MAX_KEY_POINTS} 条`)
    return {
      pageType: nonEmptyString(page.pageType, `pages[${index}].pageType`),
      intent: nonEmptyString(page.intent, `pages[${index}].intent`),
      keyPoints: points.slice(0, MAX_KEY_POINTS).map((point) => (point as string).trim()),
      ...(typeof page.dataHint === 'string' && page.dataHint.trim() ? { dataHint: page.dataHint.trim() } : {}),
      ...(typeof page.layout === 'string' && page.layout.trim() ? { layout: page.layout.trim() } : {}),
      ...(typeof page.visualTask === 'string' && page.visualTask.trim() ? { visualTask: page.visualTask.trim() } : {}),
      ...(typeof page.assetBrief === 'string' && page.assetBrief.trim() ? { assetBrief: page.assetBrief.trim() } : {}),
    }
  })
  if (pages.length > maxPages) warnings.push(`页面数已从 ${pages.length} 页截断为 ${maxPages} 页`)
  const requestedTheme = input.themeId
  const themeId = requestedTheme
    ?? (isPptdThemeId(value.themeId) ? value.themeId : inferPptdThemeId(`${input.brief}\n${String(value.themeId ?? '')}`))
  return { title, audience, goal, themeId, pages: pages.slice(0, maxPages) }
}

function buildOutlinePrompt(input: PptdDeckPipelineInput, design: PptdDesignSpec, maxPages: number, correction: string): string {
  const materials = clipMaterials(input.materials)
  const fixedTheme = input.themeId ? `themeId 必须是 ${input.themeId}。` : `themeId 必须从 ${PPTD_THEME_IDS.join(', ')} 中选择。`
  return [
    '请把需求整理成演示文稿大纲。只返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释。',
    `最多 ${maxPages} 页；每页 keyPoints 最多 ${MAX_KEY_POINTS} 条；大纲中不得出现坐标、bounds 或 PPTD 元素。`,
    fixedTheme,
    'JSON 结构：{"title":"...","audience":"...","goal":"...","themeId":"business-light","pages":[{"pageType":"cover|agenda|section|content|comparison|timeline|chart|table|summary","intent":"本页唯一结论","layout":"版式骨架","visualTask":"主视觉与阅读顺序","keyPoints":["..."],"dataHint":"可选","assetBrief":"可选，所需真实图片或截图"}]}',
    '每一页必须给出不同且由内容驱动的 layout 与 visualTask；不要连续复用同一构图，不要把所有正文页都写成项目符号。',
    `<design_spec>\n${JSON.stringify(design)}\n</design_spec>`,
    correction ? `上一次输出无效：${correction}。请严格修正结构。` : '',
    `<brief>\n${input.brief.trim()}\n</brief>`,
    materials ? `<materials>\n${materials}\n</materials>` : '',
  ].filter(Boolean).join('\n\n')
}

function buildPagePrompt(
  outline: DeckOutline,
  page: DeckOutlinePage,
  pageIndex: number,
  theme: ReturnType<typeof getPptdThemePreset>,
  design: PptdDesignSpec,
): string {
  return [
    `生成第 ${pageIndex + 1}/${outline.pages.length} 页。只返回一个 .page YAML 文档，不要代码围栏，不要解释。`,
    '页面尺寸固定为 960x540。安全边距至少 48。所有 bounds 必须是 [x,y,width,height] 且位于画布内。',
    '顶层只能包含 pageType、可选 background、elements。每个 elementId 在本页唯一。',
    '支持 text、shape、line、icon、table、chart。当前没有 media，禁止生成 image 元素或远程 URL。',
    'text 元素格式示例：{elementId: title, elementType: text, bounds: [64,48,832,64], content: {text: 标题, fontSize: 32, color: "$text", bold: true}}。',
    '同页 text bounds 不得重叠。正文不小于 14pt，标题不小于 28pt。通过图表、表格、形状关系、细线和留白表达结构，禁止把 keyPoints 原样堆成大段项目符号。',
    '严格执行 visualTask、layout 和设计规范。每个元素都必须服务于本页结论；相邻页面不得机械重复相同版式。',
    `<design_spec>\n${JSON.stringify(design)}\n</design_spec>`,
    `<theme>\n${JSON.stringify(theme)}\n</theme>`,
    `<page_outline>\n${JSON.stringify(page)}\n</page_outline>`,
  ].join('\n\n')
}

function buildRepairPrompt(
  outline: DeckOutline,
  state: PageState,
  diagnostics: PptdDiagnostic[],
  theme: ReturnType<typeof getPptdThemePreset>,
  design: PptdDesignSpec,
): string {
  return [
    `修复第 ${state.pageIndex + 1}/${outline.pages.length} 页。只返回完整替换用的 .page YAML，不要代码围栏，不要解释。`,
    '保持本页结论和关键内容，做最小必要修改。所有 bounds 必须位于 960x540 内，text 元素不得重叠。当前没有 media，禁止 image。',
    '修复不能抹掉原有视觉层级或改成项目符号文字页；继续遵守设计规范和 visualTask。',
    `<design_spec>\n${JSON.stringify(design)}\n</design_spec>`,
    `<theme>\n${JSON.stringify(theme)}\n</theme>`,
    `<page_outline>\n${JSON.stringify(state.outline)}\n</page_outline>`,
    `<diagnostics>\n${formatDiagnostics(diagnostics)}\n</diagnostics>`,
    `<current_page>\n${state.raw || '(empty)'}\n</current_page>`,
  ].join('\n\n')
}

function fallbackPage(page: DeckOutlinePage, theme: ReturnType<typeof getPptdThemePreset>, reason: string): PptdPage {
  const textColor = theme.colors.text ?? '#111827'
  const muted = theme.colors.muted ?? textColor
  const accent = theme.colors.accent ?? '#2563EB'
  const background = theme.colors.bg ?? '#FFFFFF'
  const body = page.keyPoints.slice(0, MAX_KEY_POINTS).map((point) => `• ${point}`).join('\n')
  return {
    pageType: page.pageType,
    background: { color: background },
    elements: [
      {
        elementId: 'fallback-accent', elementType: 'shape', bounds: [48, 48, 8, 420],
        shapeName: 'rect', fill: { type: 'solid', color: accent }, stroke: { color: accent },
      },
      {
        elementId: 'fallback-title', elementType: 'text', bounds: [80, 54, 800, 64],
        content: { text: page.intent.slice(0, 120), fontSize: 30, color: textColor, bold: true, lineHeight: 1.1 },
      },
      {
        elementId: 'fallback-body', elementType: 'text', bounds: [80, 150, 800, 270],
        content: { text: body.slice(0, 900), fontSize: 18, color: textColor, lineHeight: 1.35 },
      },
      {
        elementId: 'fallback-note', elementType: 'text', bounds: [80, 468, 800, 24],
        content: { text: reason, fontSize: 11, color: muted, lineHeight: 1.1 },
      },
    ],
  }
}

function pendingPreviewState(
  page: DeckOutlinePage,
  pageIndex: number,
  theme: ReturnType<typeof getPptdThemePreset>,
): PageState {
  const background = theme.colors.bg ?? '#FFFFFF'
  const surface = theme.colors.surface ?? background
  const muted = theme.colors.muted ?? theme.colors.text ?? '#64748B'
  const accent = theme.colors.accent ?? '#2563EB'
  const pagePath = pagePathFor(pageIndex)
  return {
    pageIndex,
    pagePath,
    outline: page,
    raw: '',
    page: {
      pageType: page.pageType,
      background: { type: 'solid', color: background },
      elements: [
        {
          elementId: 'pending-track', elementType: 'shape', bounds: [72, 258, 816, 4],
          shapeName: 'rect', fill: { type: 'solid', color: surface }, stroke: { color: surface },
        },
        {
          elementId: 'pending-progress', elementType: 'shape', bounds: [72, 258, Math.max(8, 816 * ((pageIndex + 1) / Math.max(1, pageIndex + 2))), 4],
          shapeName: 'rect', fill: { type: 'solid', color: accent }, stroke: { color: accent },
        },
        {
          elementId: 'pending-label', elementType: 'text', bounds: [72, 278, 816, 30],
          content: { text: `第 ${pageIndex + 1} 页正在生成`, fontSize: 14, color: muted, align: 'center' },
        },
      ],
    },
    attempts: 0,
    repaired: false,
    fallback: false,
    diagnostics: [],
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = stripCodeFence(raw)
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    }
  }
  throw new Error('输出不是有效 JSON 对象')
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(/^```(?:json|yaml|yml)?\s*\n?([\s\S]*?)\n?\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function clipMaterials(materials?: string): string {
  const text = materials?.trim() ?? ''
  if (text.length <= MAX_MATERIAL_CHARS) return text
  return `${text.slice(0, MAX_MATERIAL_CHARS)}\n[...materials truncated...]`
}

function clipDesignResource(text: string, maxChars: number): string {
  const value = text.trim()
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[...design reference clipped...]`
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`)
  return value as Record<string, unknown>
}

function hexColor(value: unknown, field: string): string {
  const color = nonEmptyString(value, field)
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${field} 必须是 #RRGGBB 颜色`)
  return color.toUpperCase()
}

function boundedNumber(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的数字`)
  }
  return value
}

function boundedIntegerValue(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number') throw new Error(`${name} 必须是整数`)
  return boundedInteger(value, minimum, maximum, name)
}

function stringArray(value: unknown, field: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
  const result = value.map((item) => nonEmptyString(item, field))
  if (result.length < minimum || result.length > maximum) throw new Error(`${field} 必须包含 ${minimum}-${maximum} 条`)
  return result
}

function safeArtifactPath(path?: string): string {
  const normalized = path?.trim().replace(/\\/g, '/').replace(/^\.\//, '') || '03-交付物/deck.pptd'
  if (normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`PPTD artifact 路径不安全：${normalized}`)
  }
  return normalized
}

function pagePathFor(pageIndex: number): string {
  return `pages/${String(pageIndex + 1).padStart(2, '0')}.page`
}

function pageDiagnostic(path: string, message: string, code: string): PptdDiagnostic {
  return { path, message, code, severity: 'error' }
}

function formatDiagnostics(diagnostics: readonly PptdDiagnostic[]): string {
  return diagnostics.map((item) => `${item.path} [${item.code ?? item.severity}]: ${item.message}`).join('\n')
}

function dedupeDiagnostics(diagnostics: readonly PptdDiagnostic[]): PptdDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((item) => {
    const key = `${item.path}\u0000${item.code}\u0000${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`)
  return value.trim()
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'PPTD 管线已取消')
  error.name = 'AbortError'
  throw error
}

function startProgressHeartbeat(report: () => void): ReturnType<typeof setInterval> {
  return setInterval(report, PROGRESS_HEARTBEAT_MS)
}

function estimateUsage(request: PptdModelCall, output: string): TokenUsage {
  const inputTokens = estimateTokens(`${request.system}\n${request.prompt}`)
  const outputTokens = estimateTokens(output)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const OUTLINE_SYSTEM_PROMPT = '你是演示文稿信息架构师。输出必须是满足用户给定结构的单个 JSON 对象。不要生成页面坐标、PPTD YAML、Markdown 或解释。'

const DESIGN_SYSTEM_PROMPT = '你是资深演示文稿艺术指导。你的任务是把场景方法、设计系统和参考样页压缩为一套可执行且内容驱动的视觉规范，避免模板化 AI 排版。输出必须是满足给定结构的单个 JSON 对象。'

const PAGE_SYSTEM_PROMPT = '你是 PPTD v2 页面排版器。输出必须是单个可解析的 YAML 页面文档。严格遵守 960x540 边界、元素契约和诊断要求，不要输出 Markdown 围栏或解释。'
