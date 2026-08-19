import { dump as dumpYaml, load as parseYaml } from 'js-yaml'
import type { CompletionRequest, ModelError, TokenUsage, UnifiedMessage } from '../model'
import { estimateTokens } from '../engine/context-budget'
import { SubAgentScheduler, type ScheduledResult } from '../engine/sub-agent/scheduler'
import type { QueryContext } from '../engine/types'
import { assemblePptdProject, type PptdAssemblyResult } from './assemble'
import { serializePptdArtifactContent, type PptdArtifactQualityReport } from './artifact'
import {
  fallbackPptdDesignSpec,
  resolvePptdDesignSource,
  themeFromDesignSpec,
  type PptdDesignSource,
  type PptdDesignSpec,
} from './design-resources'
import { pptdMediaDataUrl } from './media'
import { parsePptdPage } from './parse'
import { generatePlanningDraft, parsePlanningDraft, planningPromptBounds, type PptdPlanningDraft } from './planning'
import { fallbackPlanningDraft } from './bento-layout'
import { buildPptdReviewPrompt, capturePptdPageImages, runPptdReviewLoop } from './review'
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
const MAX_EMPTY_OUTPUT_ATTEMPTS = 2
const PREVIEW_INTERVAL = 4
const MAX_PIPELINE_CONCURRENCY = 5
const DEFAULT_MAX_PAGES = 24
const MAX_KEY_POINTS = 6
const MAX_MATERIAL_CHARS = 48_000
const MAX_SOURCE_CHARS = 64_000
const MAX_SOURCE_SECTIONS = 80
const PROGRESS_HEARTBEAT_MS = 10_000
const MAX_MEDIA_FILE_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_TOTAL_BYTES = 40 * 1024 * 1024
const OUTLINE_MAX_TOKENS = 3_200
const DESIGN_MAX_TOKENS = 4_000
const PAGE_MAX_TOKENS = 4_800
const PAGE_REPAIR_MAX_TOKENS = 5_200
const SOURCE_MAX_TOKENS = 2_200
export interface DeckOutlinePage {
  pageType: string
  intent: string
  keyPoints: string[]
  dataHint?: string
  layout?: string
  visualTask?: string
  assetBrief?: string
  evidenceIds?: string[]
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
  attachmentSources?: readonly PptdSourceDocument[]
  title?: string
  themeId?: PptdThemeId
  designSystemId?: string
  media?: Readonly<Record<string, string | Uint8Array>>
  maxPages?: number
  artifactPath?: string
}

export interface PptdSourceDocument { id: string; name: string; text: string }
export interface PptdSourceSection { id: string; attachmentId: string; attachmentName: string; title?: string; summary: string; evidence: string[] }
export interface PptdSourceIndex { summary: string; sections: PptdSourceSection[] }

export type PptdPipelineStage = 'source' | 'design' | 'outline' | 'planning' | 'page' | 'repair' | 'review'

export interface PptdModelCall {
  stage: PptdPipelineStage
  runId: string
  system: string
  prompt: string
  maxTokens: number
  pageIndex?: number
  images?: readonly PptdModelImage[]
}

export interface PptdModelImage {
  path: string
  dataUrl: string
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
  sourceIndex: PptdSourceIndex
  design: PptdDesignSpec
  outline: DeckOutline
  planningDrafts: PptdPlanningDraft[]
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
  visualReview?: { visionAvailable: boolean; maxRounds?: number }
  onProgress?: (progress: PptdPipelineProgress) => void
  onCheckpoint?: (checkpoint: PptdCheckpoint) => Promise<void>
  loadCheckpoint?: (path: string) => Promise<string | undefined>
}

export interface PptdCheckpoint {
  path: string
  content: string
  kind: 'manifest' | 'page'
  pageIndex?: number
}

export interface RunPptdDeckPipelineOptions extends Omit<GeneratePptdDeckOptions, 'callModel' | 'signal'> {
  signal?: AbortSignal
}

interface PageState {
  pageIndex: number
  pagePath: string
  outline: DeckOutlinePage
  planning?: PptdPlanningDraft
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

class PptdEmptyModelOutputError extends Error {
  constructor(stage: PptdPipelineStage, attempts: number) {
    super(`PPTD ${stage} 模型连续 ${attempts} 次返回空内容`)
    this.name = 'PptdEmptyModelOutputError'
  }
}

class PptdOutputLimitError extends Error {
  constructor(stage: PptdPipelineStage) {
    super(`PPTD ${stage} 输出达到 token 上限`)
    this.name = 'PptdOutputLimitError'
  }
}

class PptdContentGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptdContentGenerationError'
  }
}

class PptdTechnicalModelError extends Error {
  readonly modelError: ModelError

  constructor(error: ModelError) {
    super(`PPTD 模型调用失败：${error.message}`)
    this.name = 'PptdTechnicalModelError'
    this.modelError = error
  }
}

interface PptdCheckpointMetadata {
  schemaVersion: 1
  sourceHash: string
  design: PptdDesignSpec
  outline: DeckOutline
  planningDrafts?: PptdPlanningDraft[]
}

/**
 * Runs the complete bounded generation pipeline with an injected model caller.
 * Design, outline, planning, page generation and targeted repair call the model.
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
  const checkpointWrites = createCheckpointWriteQueue()
  const warnings: string[] = []
  const qualityNotices: string[] = []
  const media = preparePptdMedia(input.media)

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

  const sourceIndex = await generateSourceIndex(input, callModel, signal, warnings, options.onProgress)
  const designSource = resolvePptdDesignSource(`${input.brief}\n${sourceIndex.summary}`, input.designSystemId)
  const baseThemeId = input.themeId ?? inferPptdThemeId(`${input.brief}\n${sourceIndex.summary}`)
  const baseTheme = getPptdThemePreset(baseThemeId)
  const checkpointRoot = checkpointRootFor(input)
  const sourceHash = checkpointSourceHash(input)
  const savedCheckpoint = await loadCheckpointMetadata(options.loadCheckpoint, checkpointRoot, sourceHash)
  let design: PptdDesignSpec | undefined
  let outline: DeckOutline | undefined
  let planningDrafts: PptdPlanningDraft[] | undefined
  if (savedCheckpoint) {
    try {
      design = normalizeDesignSpec(recordField(savedCheckpoint.design, 'checkpoint.design'), designSource, baseTheme)
      outline = normalizeOutline(recordField(savedCheckpoint.outline, 'checkpoint.outline'), input, maxPages, [])
      if (Array.isArray(savedCheckpoint.planningDrafts) && savedCheckpoint.planningDrafts.length === outline.pages.length) {
        planningDrafts = savedCheckpoint.planningDrafts.map((draft, pageIndex) => parseStoredPlanningDraft(draft, outline!.pages[pageIndex], pageIndex))
      }
      warnings.push('已从工作区检查点恢复视觉系统和大纲')
    } catch {
      design = undefined
      outline = undefined
      planningDrafts = undefined
    }
  }
  design ??= await generateDesignSpec(input, designSource, baseTheme, sourceIndex, '', callModel, signal, warnings, options.onProgress)
  outline ??= await generateOutline(input, design, sourceIndex, maxPages, '', callModel, signal, warnings, options.onProgress)
  const theme = themeFromDesignSpec(getPptdThemePreset(outline.themeId), design)
  const scheduler = new SubAgentScheduler(concurrency)
  if (!planningDrafts) {
    planningDrafts = Array.from({ length: outline.pages.length })
    let completedPlanning = 0
    options.onProgress?.({ stage: 'planning', current: 0, total: outline.pages.length, message: `正在规划 ${outline.pages.length} 页布局结构` })
    const planningResults = await scheduler.run(outline.pages, async (pageOutline, pageIndex) => {
      let draft: PptdPlanningDraft
      try {
        draft = await generatePlanningDraft(outline, pageOutline, pageIndex, design, callModel, signal)
      } catch (error) {
        if (!isPptdContentFailure(error)) throw error
        draft = fallbackPlanningDraft(pageOutline, pageIndex)
        warnings.push(`第 ${pageIndex + 1} 页策划稿生成失败，已使用确定性布局草图：${errorMessage(error)}`)
      }
      planningDrafts![pageIndex] = draft
      completedPlanning++
      options.onProgress?.({ stage: 'planning', current: completedPlanning, total: outline.pages.length, pageIndex, message: `已完成 ${completedPlanning}/${outline.pages.length} 页策划稿` })
      return draft
    }, signal)
    const technicalPlanningFailure = planningResults.find((entry) => entry.status === 'rejected')
    if (technicalPlanningFailure?.status === 'rejected') throw technicalPlanningFailure.reason
  } else {
    warnings.push(`已从工作区检查点恢复 ${planningDrafts.length}/${outline.pages.length} 页策划稿`)
  }
  const previewStates = outline.pages.map((page, pageIndex) => pendingPreviewState(page, pageIndex, theme))
  await saveCheckpointManifest(options.onCheckpoint, checkpointRoot, sourceHash, design, outline, planningDrafts, theme, previewStates, media.values)
  const restoredStates = await restoreCheckpointPages(options.loadCheckpoint, checkpointRoot, sourceHash, outline, design, planningDrafts, theme)
  const restoredCount = restoredStates.filter(Boolean).length
  if (restoredCount > 0) warnings.push(`已从工作区检查点恢复 ${restoredCount}/${outline.pages.length} 页`)
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
        let state = restoredStates[pageIndex]
        if (!state) {
          try {
            const pageMedia = selectPageMedia(media.images, pageOutline)
            const result = await callModel({
              stage: 'page',
              runId: `pptd:page:${pageIndex + 1}`,
              system: PAGE_SYSTEM_PROMPT,
              prompt: buildPagePrompt(outline, pageOutline, pageIndex, theme, design, planningDrafts[pageIndex], sourceEvidenceForPage(sourceIndex, pageOutline), buildMediaPrompt(pageMedia), designSource.examplePage),
              maxTokens: PAGE_MAX_TOKENS,
              pageIndex,
              images: pageMedia,
            })
            state = parsePageState(result.text, pageOutline, pageIndex, pagePath, theme)
            state.planning = planningDrafts[pageIndex]
          } catch (error) {
            if (!isPptdContentFailure(error)) throw error
            const diagnostic = pageDiagnostic(pagePath, `页面生成调用失败：${errorMessage(error)}`, 'generation-failed')
            state = {
              pageIndex,
              pagePath,
              outline: pageOutline,
              raw: '',
              page: fallbackPage(pageOutline, theme, '页面生成失败，等待自动修复'),
              planning: planningDrafts[pageIndex],
              parseError: diagnostic,
              attempts: 1,
              repaired: false,
              fallback: false,
              diagnostics: [diagnostic],
            }
          }
        }
        state.planning ??= planningDrafts[pageIndex]
        checkpointWrites.enqueue(() => savePageCheckpoint(
          options.onCheckpoint, checkpointRoot, sourceHash, outline, design, state, !state.parseError,
        ))
        previewStates[pageIndex] = state
        hasGeneratedPreviewPage = true
        return state
      } finally {
        completedPages++
        const progress: PptdPipelineProgress = {
          stage: 'page', current: completedPages, total: outline.pages.length, pageIndex,
          message: `已完成 ${completedPages}/${outline.pages.length} 页`,
        }
        const shouldPublishPreview = completedPages === 1
          || completedPages === outline.pages.length
          || completedPages % PREVIEW_INTERVAL === 0
        if (hasGeneratedPreviewPage && shouldPublishPreview) {
          const previewAssembly = assembleStates(outline.title, theme, previewStates, media.values)
          publishPreview(options.onProgress, input, outline, previewAssembly.project, progress)
        } else {
          options.onProgress?.(progress)
        }
      }
    }, signal)
  } finally {
    clearInterval(pageHeartbeat)
  }
  await checkpointWrites.flush()
  throwIfAborted(signal)

  const technicalGenerationFailure = generated.find((entry) => entry.status === 'rejected')
  if (technicalGenerationFailure?.status === 'rejected') throw technicalGenerationFailure.reason
  const states = generated.map((entry) => (entry as Extract<ScheduledResult<PageState>, { status: 'fulfilled' }>).value)

  let assembly = assembleStates(outline.title, theme, states, media.values)
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
          const pageMedia = selectPageMedia(media.images, target.state.outline)
          const result = await callModel({
            stage: 'repair',
            runId: `pptd:repair:${target.state.pageIndex + 1}:${round}`,
            system: PAGE_SYSTEM_PROMPT,
            prompt: buildRepairPrompt(outline, target.state, diagnostics, theme, design, target.state.planning ?? planningDrafts[target.state.pageIndex], sourceEvidenceForPage(sourceIndex, target.state.outline), buildMediaPrompt(pageMedia), designSource.examplePage),
            maxTokens: PAGE_REPAIR_MAX_TOKENS,
            pageIndex: target.state.pageIndex,
            images: pageMedia,
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
    const technicalRepairFailure = repaired.find((entry) => entry.status === 'rejected' && !isPptdContentFailure(entry.reason))
    if (technicalRepairFailure?.status === 'rejected') throw technicalRepairFailure.reason
    for (const [index, entry] of repaired.entries()) {
      const target = targets[index]
      if (entry.status === 'fulfilled') {
        states[target.state.pageIndex] = entry.value
        await savePageCheckpoint(options.onCheckpoint, checkpointRoot, sourceHash, outline, design, entry.value, !entry.value.parseError)
      } else {
        target.state.attempts++
        target.state.diagnostics.push(pageDiagnostic(target.state.pagePath, `页面修复调用失败：${errorMessage(entry.reason)}`, 'repair-failed'))
      }
    }
    assembly = assembleStates(outline.title, theme, states, media.values)
    assertNoProjectErrors(assembly)
    publishPreview(options.onProgress, input, outline, assembly.project, {
      stage: 'repair',
      current: completedRepairs,
      total: targets.length,
      message: `第 ${round}/${maxRepairRounds} 轮修复结果已更新`,
    })
  }

  const unresolved = repairTargets(states, assembly)
  const fallbackTargets = unresolved.filter(({ state }) => {
    const validation = assembly.pageResults[state.pageIndex]
    return Boolean(state.parseError || validation?.errors.length)
  })
  if (fallbackTargets.length > 0) {
    const fallbackPageNumbers = fallbackTargets.map(({ state }) => {
      const diagnostics = diagnosticsForState(state, assembly)
      state.diagnostics.push(...diagnostics)
      state.page = fallbackPage(state.outline, theme, '自动生成未通过质量检查，已使用安全版式')
      state.raw = dumpYaml(state.page, { noRefs: true, lineWidth: -1 })
      state.parseError = undefined
      state.fallback = true
      return state.pageIndex + 1
    })
    assembly = assembleStates(outline.title, theme, states, media.values)
    assertNoProjectErrors(assembly)
    if (!assembly.validation.valid) {
      throw new Error(`PPTD 确定性页面兜底后仍未通过校验：${formatDiagnostics(assembly.validation.errors)}`)
    }
    warnings.push(`${fallbackTargets.length} 页在 ${maxRepairRounds} 轮修复后使用安全版式：第 ${fallbackPageNumbers.join('、')} 页`)
    await Promise.all(fallbackTargets.map(({ state }) =>
      savePageCheckpoint(options.onCheckpoint, checkpointRoot, sourceHash, outline, design, state, true)))
    publishPreview(options.onProgress, input, outline, assembly.project, {
      stage: 'repair',
      current: fallbackTargets.length,
      total: fallbackTargets.length,
      message: `${fallbackTargets.length} 页已切换为安全版式，继续交付完整演示文稿`,
    }, buildQualityReport(states, assembly))
  }
  if (options.visualReview) {
    const visual = await runProductionVisualReview(
      outline,
      design,
      theme,
      states,
      assembly,
      media.values,
      options.visualReview,
      callModel,
      signal,
      warnings,
      options.onProgress,
      designSource.examplePage,
    )
    assembly = visual.assembly
    qualityNotices.push(...visual.notices)
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

  await Promise.all(states.map((state) =>
    savePageCheckpoint(options.onCheckpoint, checkpointRoot, sourceHash, outline, design, state, true)))

  const pageReports = states.map((state) => ({
    pageIndex: state.pageIndex,
    pagePath: state.pagePath,
    status: state.fallback ? 'fallback' as const : state.repaired ? 'repaired' as const : 'generated' as const,
    attempts: state.attempts,
    diagnostics: dedupeDiagnostics(state.diagnostics),
  }))
  const artifact = createDeckArtifact(input, outline, assembly.project, buildQualityReport(states, assembly, qualityNotices))
  return { sourceIndex, design, outline, planningDrafts, project: assembly.project, assembly, artifact, pageReports, warnings, usage }
}

function publishPreview(
  onProgress: GeneratePptdDeckOptions['onProgress'],
  input: PptdDeckPipelineInput,
  outline: DeckOutline,
  project: PptdProject,
  progress: Omit<PptdPipelineProgress, 'preview'>,
  qualityReport?: PptdArtifactQualityReport,
): void {
  if (!onProgress) return
  const artifact = createDeckArtifact(input, outline, project, qualityReport)
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
  qualityReport?: PptdArtifactQualityReport,
): PptdDeckArtifact {
  const content = serializePptdArtifactContent(project, qualityReport)
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
    visualReview: { visionAvailable: ctx.providerRegistry.get(ctx.model.provider).metadata.supportsVision, maxRounds: 2 },
  })
}

/** Adapts the existing streaming provider interface to one bounded pipeline call. */
export function createPptdModelCaller(ctx: QueryContext): PptdModelCaller {
  const provider = ctx.providerRegistry.get(ctx.model.provider)
  return async (request, signal) => {
    const content = provider.metadata.supportsVision && request.images?.length
      ? [
          { type: 'text' as const, text: request.prompt },
          ...request.images.map((image) => ({ type: 'image' as const, url: image.dataUrl, detail: 'high' as const })),
        ]
      : request.prompt
    const messages: UnifiedMessage[] = [{ role: 'user', content }]
    const completion: CompletionRequest = {
      model: ctx.model.model,
      system: request.system,
      messages,
      temperature: request.stage === 'outline' ? 0.2 : request.stage === 'design' ? 0.5 : 0.4,
      maxTokens: request.maxTokens,
      stream: true,
      signal,
    }
    let totalUsage: TokenUsage | undefined
    for (let attempt = 1; attempt <= MAX_EMPTY_OUTPUT_ATTEMPTS; attempt++) {
      throwIfAborted(signal)
      let text = ''
      let usage: TokenUsage | undefined
      let stopReason: string | undefined
      let streamError: PptdTechnicalModelError | undefined
      for await (const chunk of provider.stream(completion)) {
        if (chunk.type === 'content_delta') text += chunk.delta
        else if (chunk.type === 'message_end') {
          usage = chunk.usage
          stopReason = chunk.stopReason
        } else if (chunk.type === 'error') {
          if (!chunk.error.recoverable) {
            const technical = new PptdTechnicalModelError(chunk.error)
            if (attempt < MAX_EMPTY_OUTPUT_ATTEMPTS && isRetryablePptdStreamError(chunk.error)) {
              streamError = technical
              break
            }
            throw technical
          }
        } else if (chunk.type === 'tool_call_start' || chunk.type === 'tool_call_delta' || chunk.type === 'tool_call_end') {
          throw new PptdContentGenerationError('PPTD 管线不接受模型工具调用')
        }
      }
      if (streamError) {
        totalUsage = mergeTokenUsage(totalUsage, usage ?? estimateUsage(request, text))
        continue
      }
      if (stopReason === 'max_tokens') throw new PptdOutputLimitError(request.stage)
      totalUsage = mergeTokenUsage(totalUsage, usage ?? estimateUsage(request, text))
      if (text.trim()) return { text, usage: totalUsage }
    }
    throw new PptdEmptyModelOutputError(request.stage, MAX_EMPTY_OUTPUT_ATTEMPTS)
  }
}

interface VisualReviewOutcome {
  assembly: PptdAssemblyResult
  notices: string[]
}

/** Runs the bounded production visual pass using the same local page model. */
async function runProductionVisualReview(
  outline: DeckOutline,
  design: PptdDesignSpec,
  theme: ReturnType<typeof getPptdThemePreset>,
  states: PageState[],
  initialAssembly: PptdAssemblyResult,
  media: Readonly<Record<string, string | Uint8Array>>,
  options: NonNullable<GeneratePptdDeckOptions['visualReview']>,
  callModel: (request: PptdModelCall) => Promise<PptdModelCallResult>,
  signal: AbortSignal,
  warnings: string[],
  onProgress?: (progress: PptdPipelineProgress) => void,
  referencePage?: string,
): Promise<VisualReviewOutcome> {
  if (options.visionAvailable === false) {
    const notice = '当前模型不支持 vision，已跳过 PPTD 截图审阅，仅执行结构校验'
    warnings.push(notice)
    return { assembly: initialAssembly, notices: [notice] }
  }

  const reviewMedia = preparePptdMedia(media).images
  const notices: string[] = []
  const feedbackByPage = new Map<number, string>()
  const imageByPage = new Map<number, { path: string; dataUrl: string }>()
  let reviewRound = 0
  const maxReviewRounds = Math.max(1, Math.min(2, options.maxRounds ?? 1))
  onProgress?.({ stage: 'review', current: 0, total: maxReviewRounds, message: '正在截取页面并进行视觉审阅' })
  const result = await runPptdReviewLoop(initialAssembly.project, {
    maxRounds: maxReviewRounds,
    visionAvailable: true,
    capture: async (project, pageIndexes) => capturePptdPageImages(project, pageIndexes),
    review: async (images, project) => {
      throwIfAborted(signal)
      reviewRound++
      onProgress?.({ stage: 'review', current: reviewRound - 1, total: maxReviewRounds, message: `正在进行第 ${reviewRound}/${maxReviewRounds} 轮视觉审阅` })
      feedbackByPage.clear()
      const modelImages = images.map((image) => {
        const path = `media/__pptd_review_page_${image.pageIndex + 1}.png`
        const modelImage = { path, dataUrl: image.imageDataUrl }
        imageByPage.set(image.pageIndex, modelImage)
        return modelImage
      })
      let response: PptdModelCallResult
      try {
        response = await callModel({
          stage: 'review',
          runId: `pptd:review:${reviewRound}`,
          system: REVIEW_SYSTEM_PROMPT,
          prompt: [
            `按图片顺序审阅这套 PPTD 的 ${project.pages.length} 页。${buildPptdReviewPrompt(0, project.pages.length)}`,
            `<page_outline_catalog>\n${JSON.stringify(outline.pages.map((page, pageIndex) => ({ pageIndex, pageType: page.pageType, intent: page.intent, layout: page.layout, visualTask: page.visualTask, keyPoints: page.keyPoints })))}\n</page_outline_catalog>`,
            `<page_element_catalog>\n${JSON.stringify(project.pages.map((page, pageIndex) => ({
              pageIndex,
              elements: page.elements.map((element) => ({ elementId: element.elementId, elementType: element.elementType, bounds: element.bounds })),
            })))}\n</page_element_catalog>`,
            '只返回 JSON：{"approved":true,"pages":[]}；有问题时 pages 只列问题页，结构为 {"pageIndex":0,"feedback":"包含 elementId 的最小修复建议"}。pageIndex 从 0 开始。不要评价主题内容，不要泛泛评价美观。',
          ].join('\n'),
          maxTokens: 2_200,
          images: modelImages,
        })
      } catch (error) {
        if (!isPptdContentFailure(error)) throw error
        const notice = `视觉审阅未返回可用结果，已保留结构合法版本：${errorMessage(error)}`
        warnings.push(notice)
        notices.push(notice)
        return { approved: true, feedback: '' }
      }
      const text = response.text.trim()
      if (/^APPROVED(?:\s|$)/i.test(text)) return { approved: true, feedback: '' }
      try {
        const parsed = parseJsonObject(text)
        const pages = Array.isArray(parsed.pages) ? parsed.pages : []
        for (const item of pages) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const record = item as Record<string, unknown>
          const pageIndex = typeof record.pageIndex === 'number' && Number.isInteger(record.pageIndex) ? record.pageIndex : -1
          const pageFeedback = typeof record.feedback === 'string' ? record.feedback.trim() : ''
          if (pageIndex >= 0 && pageIndex < project.pages.length && pageFeedback) feedbackByPage.set(pageIndex, pageFeedback)
        }
        if (parsed.approved === true && feedbackByPage.size === 0) return { approved: true, feedback: '' }
      } catch {
        // Treat malformed review output as feedback for the first page so the
        // bounded repair/review loop can recover without multiplying calls.
      }
      if (feedbackByPage.size === 0 && project.pages.length > 0) feedbackByPage.set(0, text || '截图审阅没有返回有效 JSON')
      return {
        approved: false,
        feedback: [...feedbackByPage.entries()].map(([pageIndex, value]) => `第 ${pageIndex + 1} 页：${value}`).join('\n'),
      }
    },
    repair: async (project, feedback, validation) => {
      const nextPages = [...project.pages]
      const targets = feedbackByPage.size > 0 ? [...feedbackByPage.keys()] : []
      onProgress?.({ stage: 'review', current: Math.max(0, reviewRound - 1), total: maxReviewRounds, message: `视觉审阅发现 ${targets.length} 页需要定向修复` })
      const repairScheduler = new SubAgentScheduler(Math.min(MAX_PIPELINE_CONCURRENCY, Math.max(1, targets.length)))
      const repairedPages = await repairScheduler.run(targets, async (pageIndex) => {
        throwIfAborted(signal)
        const page = project.pages[pageIndex]
        const pageOutline = outline.pages[pageIndex]
        if (!page || !pageOutline) return undefined
        const pagePath = project.pagePaths[pageIndex] ?? pagePathFor(pageIndex)
        const previous: PageState = {
          pageIndex,
          pagePath,
          outline: pageOutline,
          planning: states[pageIndex]?.planning,
          raw: JSON.stringify(page),
          page,
          attempts: states[pageIndex]?.attempts ?? 1,
          repaired: Boolean(states[pageIndex]?.repaired),
          fallback: Boolean(states[pageIndex]?.fallback),
          diagnostics: [],
        }
        const diagnostics = [
          ...(validation.errors.filter((item) => item.path === pagePath || item.path.startsWith(`${pagePath}:`))),
          { path: pagePath, message: `视觉审阅：${feedbackByPage.get(pageIndex) ?? feedback}`, severity: 'error' as const, code: 'visual-review' },
        ]
        const pageMedia = selectPageMedia(reviewMedia, pageOutline)
        const response = await callModel({
          stage: 'repair',
          runId: `pptd:visual-repair:${pageIndex + 1}`,
          system: PAGE_SYSTEM_PROMPT,
          prompt: buildRepairPrompt(outline, previous, diagnostics, theme, design, previous.planning, '', buildMediaPrompt(pageMedia), referencePage),
          maxTokens: PAGE_REPAIR_MAX_TOKENS,
          pageIndex,
          images: [
            ...pageMedia,
            ...(imageByPage.get(pageIndex) ? [imageByPage.get(pageIndex)!] : []),
          ],
        })
        const repaired = parsePageState(response.text, pageOutline, pageIndex, pagePath, theme, previous)
        return repaired.parseError ? undefined : repaired
      }, signal)
      const technicalRepairFailure = repairedPages.find((entry) => entry.status === 'rejected' && !isPptdContentFailure(entry.reason))
      if (technicalRepairFailure?.status === 'rejected') throw technicalRepairFailure.reason
      repairedPages.forEach((entry, index) => {
        if (entry.status !== 'fulfilled' || !entry.value) return
        const pageIndex = targets[index]
        nextPages[pageIndex] = entry.value.page
        states[pageIndex] = { ...entry.value, repaired: true }
      })
      onProgress?.({ stage: 'review', current: reviewRound, total: maxReviewRounds, message: `第 ${reviewRound}/${maxReviewRounds} 轮视觉审阅修复完成` })
      return {
        ...project,
        pages: nextPages,
        media: { ...media },
      }
    },
  })

  if (!result.approved) {
    const notice = `PPTD 视觉审阅在 ${result.rounds} 轮后仍有问题，已保留结构合法版本：${result.feedback.at(-1) ?? '无具体反馈'}`
    warnings.push(notice)
    notices.push(notice)
  }
  const assembly = assemblePptdProject({
    title: result.project.title,
    theme,
    pages: result.project.pages,
    pagePaths: result.project.pagePaths,
    media,
  })
  return { assembly, notices }
}

function generateSourceIndex(
  input: PptdDeckPipelineInput,
  callModel: PptdModelCaller,
  signal: AbortSignal,
  warnings: string[],
  onProgress?: (progress: PptdPipelineProgress) => void,
): Promise<PptdSourceIndex> {
  const documents = input.attachmentSources ?? []
  const documentTextById = new Map(documents.map((document) => [document.id, document.text.slice(0, MAX_SOURCE_CHARS)]))
  const sections: PptdSourceSection[] = []
  for (const document of documents) {
    const text = document.text.slice(0, MAX_SOURCE_CHARS)
    const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)]
    const points = headings.length > 0
      ? headings.map((match, index) => ({ title: match[2]?.trim(), start: match.index ?? 0, end: headings[index + 1]?.index ?? text.length }))
      : [{ title: undefined, start: 0, end: text.length }]
    points.forEach((point, index) => {
      if (sections.length >= MAX_SOURCE_SECTIONS) return
      const body = text.slice(point.start, point.end).replace(/\s+/g, ' ').trim()
      if (!body) return
      sections.push({
        id: `${document.id}:section-${String(index + 1).padStart(2, '0')}`,
        attachmentId: document.id,
        attachmentName: document.name,
        ...(point.title ? { title: point.title } : {}),
        summary: body.slice(0, 700),
        evidence: splitEvidence(body),
      })
    })
  }
  const supplied = input.materials?.trim() ?? ''
  const summary = [
    `用户需求：${input.brief.trim()}`,
    documents.length > 0 ? `附件：${documents.map((document) => `${document.name}（${document.text.length} 字符）`).join('、')}` : '',
    supplied ? `补充材料：${supplied.slice(0, 8_000)}` : '',
    sections.length > 0 ? `材料章节：${sections.map((section) => section.title ?? section.attachmentName).join('、')}` : '',
  ].filter(Boolean).join('\n')
  const localIndex = { summary, sections }
  if (sections.length === 0) return Promise.resolve(localIndex)
  onProgress?.({ stage: 'source', current: 1, total: 1, message: `正在索引 ${sections.length} 个附件章节` })
  return callModel({
    stage: 'source',
    runId: 'pptd:source:1',
    system: '你是演示文稿材料分析师。只返回 JSON，不要解释。保留事实，不要编造；每条 evidence 必须能在输入材料中找到。',
    prompt: [
      '请把以下材料索引压缩成适合 PPT 策划使用的来源摘要。不要输出全文。',
      '输出格式：{"summary":"...","sections":[{"id":"原 id","summary":"不超过300字","evidence":["可核验句子"]}]}。只保留输入中已有的章节 id。',
      `<brief>\n${input.brief.slice(0, 4_000)}\n</brief>`,
      `<source_index>\n${clipSourceIndex(localIndex)}\n</source_index>`,
    ].join('\n\n'),
    maxTokens: SOURCE_MAX_TOKENS,
  }, signal).then((result) => {
    try {
      const parsed = parseJsonObject(result.text)
      const byId = new Map(sections.map((section) => [section.id, section]))
      const refinedSections = Array.isArray(parsed.sections)
        ? parsed.sections.flatMap((item) => {
            if (!isRecord(item) || typeof item.id !== 'string') return []
            const original = byId.get(item.id)
            if (!original) return []
            return [{
              ...original,
              summary: typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim().slice(0, 700) : original.summary,
              evidence: verifiedSourceEvidence(item.evidence, original, documentTextById),
            }]
          })
        : sections
      return {
        summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? `${summary}\n材料分析：${parsed.summary.trim().slice(0, 4_000)}` : summary,
        sections: refinedSections.length > 0 ? refinedSections : sections,
      }
    } catch {
      warnings.push('附件材料分析输出无法解析，已使用确定性来源索引')
      return localIndex
    }
  }).catch((error) => {
    if (!isPptdContentFailure(error)) throw error
    warnings.push(`附件材料分析未完成，已使用确定性来源索引：${errorMessage(error)}`)
    return localIndex
  })
}

function verifiedSourceEvidence(
  value: unknown,
  original: PptdSourceSection,
  documentTextById: ReadonlyMap<string, string>,
): string[] {
  if (!Array.isArray(value)) return original.evidence
  const document = documentTextById.get(original.attachmentId) ?? ''
  const verified = value.filter((item): item is string =>
    typeof item === 'string' && Boolean(item.trim()) && document.includes(item.trim()),
  ).slice(0, 8)
  return verified.length > 0 ? verified : original.evidence
}

function splitEvidence(text: string): string[] {
  return text.split(/[。！？；\n]/).map((part) => part.trim()).filter((part) => part.length >= 8).slice(0, 8)
}

function sourceEvidenceForPage(index: PptdSourceIndex, page: DeckOutlinePage): string {
  const explicit = new Set(page.evidenceIds ?? [])
  const query = [page.intent, page.visualTask, ...page.keyPoints].join(' ').toLowerCase()
  const terms = extractSearchTerms(query)
  const selected = index.sections
    .map((section) => ({ section, score: (explicit.has(section.id) ? 100 : 0) + terms.reduce((score, term) => score + (section.summary.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ section }) => ({ id: section.id, source: section.attachmentName, title: section.title, evidence: section.evidence }))
  return JSON.stringify(selected)
}

function clipSourceIndex(index: PptdSourceIndex, limit = 24_000): string {
  const sections: Array<Record<string, unknown>> = []
  const summary = index.summary.slice(0, 4_000)
  for (const section of index.sections) {
    const compactSection = {
      id: section.id,
      attachmentName: section.attachmentName,
      title: section.title,
      summary: section.summary.slice(0, 420),
      evidence: section.evidence.slice(0, 4).map((value) => value.slice(0, 220)),
    }
    const candidate = JSON.stringify({ summary, sections: [...sections, compactSection] })
    if (candidate.length > limit) break
    sections.push(compactSection)
  }
  return JSON.stringify({ summary, sections })
}

function selectPageMedia(images: readonly PptdModelImage[], page: DeckOutlinePage): PptdModelImage[] {
  if (images.length === 0) return []
  const request = [page.intent, page.visualTask, page.assetBrief ?? ''].join(' ').toLowerCase()
  if (!/(image|photo|picture|screenshot|logo|图|图片|照片|截图|配图|视觉素材)/i.test(request)) return []
  const terms = extractSearchTerms(request)
  const ranked = images.map((image) => ({ image, score: terms.reduce((score, term) => score + (image.path.toLowerCase().includes(term) ? 1 : 0), 0) }))
  return ranked.sort((left, right) => right.score - left.score).slice(0, 2).map(({ image }) => image)
}

function extractSearchTerms(value: string): string[] {
  const latin = value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1)
  const cjk = [...value.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0] ?? '')
  return [...new Set([...latin, ...cjk])].slice(0, 40)
}

async function generateOutline(
  input: PptdDeckPipelineInput,
  design: PptdDesignSpec,
  sourceIndex: PptdSourceIndex,
  maxPages: number,
  mediaPrompt: string,
  callModel: (request: PptdModelCall) => Promise<PptdModelCallResult>,
  signal: AbortSignal,
  warnings: string[],
  onProgress?: (progress: PptdPipelineProgress) => void,
): Promise<DeckOutline> {
  let parseFailure = ''
  for (let attempt = 1; attempt <= MAX_OUTLINE_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    onProgress?.({ stage: 'outline', current: attempt, total: MAX_OUTLINE_ATTEMPTS, message: attempt === 1 ? '生成演示文稿大纲' : '修正大纲结构' })
    let result: PptdModelCallResult
    try {
      result = await callModel({
        stage: 'outline',
        runId: `pptd:outline:${attempt}`,
        system: OUTLINE_SYSTEM_PROMPT,
        prompt: buildOutlinePrompt(input, design, sourceIndex, maxPages, parseFailure, mediaPrompt),
        maxTokens: OUTLINE_MAX_TOKENS,
      })
    } catch (error) {
      // Output ceilings receive a compact structure retry. Empty streams have
      // already been retried by the provider adapter, so fall back directly.
      if (isPptdEmptyOutputError(error)) {
        parseFailure = errorMessage(error)
        break
      }
      if (!isPptdOutputLimitError(error)) {
        if (isPptdContentFailure(error)) {
          parseFailure = errorMessage(error)
          break
        }
        throw error
      }
      parseFailure = errorMessage(error)
      continue
    }
    try {
      const attemptWarnings: string[] = []
      const outline = normalizeOutline(parseJsonObject(result.text), input, maxPages, attemptWarnings)
      warnings.push(...attemptWarnings)
      return outline
    } catch (error) {
      parseFailure = errorMessage(error)
    }
  }
  warnings.push(`大纲在 ${MAX_OUTLINE_ATTEMPTS} 次尝试后仍无效，已使用确定性大纲：${parseFailure}`)
  return fallbackDeckOutline(input, maxPages)
}

function fallbackDeckOutline(input: PptdDeckPipelineInput, maxPages: number): DeckOutline {
  const title = input.title?.trim() || firstBriefLine(input.brief) || '演示文稿方案'
  const evidence = compactOutlineText(input.brief, '围绕需求梳理现状、关键判断与执行路径')
  const pages: DeckOutlinePage[] = [
    {
      pageType: 'cover',
      intent: title,
      keyPoints: [title],
      layout: '封面：标题与副标题左对齐',
      visualTask: '建立主题、对象与汇报目标的第一印象',
    },
    {
      pageType: 'content',
      intent: '当前需求的核心判断',
      keyPoints: [evidence],
      layout: '左侧结论，右侧证据与解释',
      visualTask: '用层级和留白突出唯一核心结论',
    },
    {
      pageType: 'summary',
      intent: '建议路径与下一步行动',
      keyPoints: ['明确优先级', '落实责任人与时间节点', '建立复盘与反馈机制'],
      layout: '结论上方，行动路径下方',
      visualTask: '把结论收束为可执行的下一步',
    },
  ]
  return {
    title,
    audience: '相关决策者与执行团队',
    goal: '围绕需求形成可执行结论与行动路径',
    themeId: input.themeId ?? inferPptdThemeId(`${input.brief}\n${input.materials ?? ''}`),
    pages: pages.slice(0, maxPages),
  }
}

function firstBriefLine(brief: string): string {
  const line = brief.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? ''
  return line.replace(/^#{1,6}\s*/, '').replace(/\s+/g, ' ').slice(0, 80)
}

function compactOutlineText(text: string, fallback: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, 180) : fallback
}

async function generateDesignSpec(
  input: PptdDeckPipelineInput,
  source: PptdDesignSource,
  baseTheme: ReturnType<typeof getPptdThemePreset>,
  sourceIndex: PptdSourceIndex,
  mediaPrompt: string,
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
    let result: PptdModelCallResult
    try {
      result = await callModel({
        stage: 'design',
        runId: `pptd:design:${attempt}`,
        system: DESIGN_SYSTEM_PROMPT,
        prompt: buildDesignPrompt(input, source, baseTheme, sourceIndex, parseFailure, mediaPrompt),
        maxTokens: DESIGN_MAX_TOKENS,
      })
    } catch (error) {
      // Output ceilings receive a compact structure retry. Empty streams have
      // already been retried by the provider adapter, so fall back directly.
      if (isPptdEmptyOutputError(error)) {
        parseFailure = errorMessage(error)
        break
      }
      if (!isPptdOutputLimitError(error)) {
        if (isPptdContentFailure(error)) {
          parseFailure = errorMessage(error)
          break
        }
        throw error
      }
      parseFailure = errorMessage(error)
      continue
    }
    try {
      return normalizeDesignSpec(parseJsonObject(result.text), source, baseTheme)
    } catch (error) {
      parseFailure = errorMessage(error)
    }
  }
  warnings.push(`视觉系统在 ${MAX_DESIGN_ATTEMPTS} 次尝试后仍无效，已使用确定性设计规范：${parseFailure}`)
  return fallbackPptdDesignSpec(source, baseTheme)
}

function isPptdOutputLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes('输出达到 token 上限')
    || message.includes('max_tokens')
    || message.includes('maximum context length')
}

function isPptdEmptyOutputError(error: unknown): boolean {
  return error instanceof PptdEmptyModelOutputError || errorMessage(error).includes('返回空内容')
}

function isRetryablePptdStreamError(error: ModelError): boolean {
  const message = error.message.toLowerCase()
  return error.kind === 'parse'
    || error.code.toLowerCase().includes('sse_parse')
    || message.includes('json parse')
    || message.includes('unterminated string')
    || message.includes('unexpected end of json')
}

function isPptdContentFailure(error: unknown): boolean {
  return error instanceof PptdContentGenerationError
    || isPptdEmptyOutputError(error)
    || isPptdOutputLimitError(error)
}

function buildDesignPrompt(
  input: PptdDeckPipelineInput,
  source: PptdDesignSource,
  baseTheme: ReturnType<typeof getPptdThemePreset>,
  sourceIndex: PptdSourceIndex,
  correction: string,
  mediaPrompt: string,
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
    `<source_summary>\n${sourceIndex.summary}\n</source_summary>`,
    mediaPrompt,
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
  const background = hexColor(palette.background, 'palette.background')
  const text = readableDesignColor(background, hexColor(palette.text, 'palette.text'), baseTheme.colors.text ?? '#172033')
  const muted = readableDesignColor(background, hexColor(palette.muted, 'palette.muted'), baseTheme.colors.muted ?? '#64748B')
  return {
    scenario: source.scenario,
    designSystemId: source.designSystemId,
    visualSignature: nonEmptyString(value.visualSignature, 'visualSignature'),
    palette: {
      background,
      surface: hexColor(palette.surface, 'palette.surface'),
      text,
      muted,
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

function readableDesignColor(background: string, candidate: string, fallback: string): string {
  if (hexContrastRatio(candidate, background) >= 4.5) return candidate
  if (hexContrastRatio(fallback, background) >= 4.5) return fallback
  return hexLuminance(background) > 0.5 ? '#111827' : '#F8FAFC'
}

function hexContrastRatio(first: string, second: string): number {
  const a = hexLuminance(first)
  const b = hexLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function hexLuminance(color: string): number {
  let hex = color.slice(1)
  if (hex.length === 3) hex = hex.split('').map((channel) => `${channel}${channel}`).join('')
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
  return channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
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
    const parsedPage = parseGeneratedPage(raw, pagePath, theme)
    return {
      pageIndex, pagePath, outline, planning: previous?.planning, raw, page: isDiagramOutlinePage(outline) ? { ...parsedPage, pageType: 'diagram' } : parsedPage,
      attempts, repaired: Boolean(previous), fallback: false,
      diagnostics: [...(previous?.diagnostics ?? [])],
    }
  } catch (error) {
    const diagnostic = pageDiagnostic(pagePath, `页面 YAML 无法解析：${errorMessage(error)}`, 'page-parse-error')
    return {
      pageIndex, pagePath, outline, planning: previous?.planning, raw,
      page: previous?.page ?? fallbackPage(outline, theme, '页面 YAML 无法解析，等待自动修复'),
      parseError: diagnostic,
      attempts,
      repaired: Boolean(previous),
      fallback: false,
      diagnostics: [...(previous?.diagnostics ?? []), diagnostic],
    }
  }
}

/**
 * Models occasionally return a valid element sequence instead of the required
 * page object, or leave a colon in a plain YAML text scalar. Repair only these
 * unambiguous boundary mistakes; the canonical PPTD parser remains strict.
 */
function parseGeneratedPage(raw: string, path: string, theme: ReturnType<typeof getPptdThemePreset>): PptdPage {
  const text = stripCodeFence(raw)
  const normalized = repairGeneratedPageYaml(text)
  try {
    return parsePptdPage(normalized, path, theme)
  } catch (initialError) {
    const repaired = normalized === text ? repairGeneratedPageYaml(text) : normalized
    if (repaired === text) throw initialError
    return parsePptdPage(repaired, path, theme)
  }
}

function repairGeneratedPageYaml(text: string): string {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    const quoted = quotePlainYamlScalars(text)
    if (quoted === text) return text
    try {
      parsed = parseYaml(quoted)
    } catch {
      // Preserve the original parser diagnostic when the conservative repair
      // did not produce a complete YAML document.
      return text
    }
    return dumpYaml(parsed, { noRefs: true, lineWidth: -1 })
  }

  if (isRecord(parsed) && isRecord(parsed.page) && Array.isArray(parsed.page.elements)) {
    return dumpYaml(parsed.page, { noRefs: true, lineWidth: -1 })
  }
  if (Array.isArray(parsed) && parsed.every(isPptdElementRecord)) {
    return dumpYaml({ elements: parsed }, { noRefs: true, lineWidth: -1 })
  }
  return text
}

function quotePlainYamlScalars(text: string): string {
  let changed = false
  const output = text.split('\n').map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][\w.-]*):(\s+)(.+)$/)
    if (!match) return line
    const value = match[4]
    // Inline maps/sequences and already quoted/block values have their own
    // YAML grammar. Only quote plain scalars containing a mapping-like colon.
    if (!value.includes(': ') || ['[', '{', '"', "'", '|', '>'].includes(value[0] ?? '')) return line
    changed = true
    return `${match[1]}${match[2]}: ${JSON.stringify(value)}`
  }).join('\n')
  return changed ? output : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPptdElementRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.elementId === 'string'
    && typeof value.elementType === 'string'
    && Array.isArray(value.bounds)
}

function assembleStates(
  title: string,
  theme: ReturnType<typeof getPptdThemePreset>,
  states: readonly PageState[],
  media: Readonly<Record<string, string | Uint8Array>>,
): PptdAssemblyResult {
  return assemblePptdProject({
    title,
    theme,
    pages: states.map((state) => state.page),
    pagePaths: states.map((state) => state.pagePath),
    media,
  })
}

function repairTargets(states: PageState[], assembly: PptdAssemblyResult): RepairTarget[] {
  return states.flatMap((state) => {
    const validation = assembly.pageResults[state.pageIndex]
    const qualityWarning = validation?.warnings.some((diagnostic) => isRepairablePageWarning(diagnostic.code))
    return state.parseError || !validation?.valid || qualityWarning ? [{ state }] : []
  })
}

function isRepairablePageWarning(code: string | undefined): boolean {
  return code === 'composition-sparse' || code === 'hidden-element' || code?.startsWith('diagram-') === true
}

function diagnosticsForState(state: PageState, assembly: PptdAssemblyResult): PptdDiagnostic[] {
  const validation = assembly.pageResults[state.pageIndex]
  return dedupeDiagnostics([
    ...state.diagnostics,
    ...(state.parseError ? [state.parseError] : []),
    ...(validation?.errors ?? []),
    ...(validation?.warnings.filter((diagnostic) => isRepairablePageWarning(diagnostic.code)) ?? []),
  ])
}

function buildQualityReport(states: readonly PageState[], assembly: PptdAssemblyResult, notices: readonly string[] = []): PptdArtifactQualityReport | undefined {
  const fallbackPages = states.filter((state) => state.fallback).map((state) => ({
    pageIndex: state.pageIndex,
    pagePath: state.pagePath,
    status: 'fallback' as const,
    reasons: dedupeDiagnostics(state.diagnostics).map((diagnostic) => diagnostic.message),
  }))
  const fallbackIndexes = new Set(fallbackPages.map((page) => page.pageIndex))
  const warningPages = states.flatMap((state) => {
    if (fallbackIndexes.has(state.pageIndex)) return []
    const warnings = assembly.pageResults[state.pageIndex]?.warnings ?? []
    return warnings.length > 0 ? [{
      pageIndex: state.pageIndex,
      pagePath: state.pagePath,
      status: 'warning' as const,
      reasons: warnings.map((diagnostic) => diagnostic.message),
    }] : []
  })
  const uniqueNotices = [...new Set(notices.filter(Boolean))]
  return fallbackPages.length > 0 || warningPages.length > 0 || uniqueNotices.length > 0
    ? { fallbackPages, warningPages, ...(uniqueNotices.length > 0 ? { notices: uniqueNotices } : {}) }
    : undefined
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
      ...(Array.isArray(page.evidenceIds)
        ? { evidenceIds: page.evidenceIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 8) }
        : {}),
    }
  })
  if (pages.length > maxPages) warnings.push(`页面数已从 ${pages.length} 页截断为 ${maxPages} 页`)
  const requestedTheme = input.themeId
  const themeId = requestedTheme
    ?? (isPptdThemeId(value.themeId) ? value.themeId : inferPptdThemeId(`${input.brief}\n${String(value.themeId ?? '')}`))
  return { title, audience, goal, themeId, pages: pages.slice(0, maxPages) }
}

function buildOutlinePrompt(
  input: PptdDeckPipelineInput,
  design: PptdDesignSpec,
  sourceIndex: PptdSourceIndex,
  maxPages: number,
  correction: string,
  mediaPrompt: string,
): string {
  const materials = clipMaterials(`${sourceIndex.summary}\n${input.materials ?? ''}`)
  const fixedTheme = input.themeId ? `themeId 必须是 ${input.themeId}。` : `themeId 必须从 ${PPTD_THEME_IDS.join(', ')} 中选择。`
  return [
    '请把需求整理成演示文稿大纲。只返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释。',
    `最多 ${maxPages} 页；每页 keyPoints 最多 ${MAX_KEY_POINTS} 条；大纲中不得出现坐标、bounds 或 PPTD 元素。`,
    fixedTheme,
    'JSON 结构：{"title":"...","audience":"...","goal":"...","themeId":"business-light","pages":[{"pageType":"cover|agenda|section|content|comparison|timeline|diagram|chart|table|summary","intent":"本页唯一结论","layout":"版式骨架","visualTask":"主视觉与阅读顺序","keyPoints":["..."],"evidenceIds":["source-section-id"],"dataHint":"可选","assetBrief":"可选，所需真实图片或截图"}]}',
    '每一页必须给出不同且由内容驱动的 layout 与 visualTask；不要连续复用同一构图，不要把所有正文页都写成项目符号。',
    `<design_spec>\n${JSON.stringify(design)}\n</design_spec>`,
    correction ? `上一次输出无效：${correction}。请严格修正结构。` : '',
    `<brief>\n${input.brief.trim()}\n</brief>`,
    `<materials>\n${materials}\n</materials>`,
    `<source_index>\n${JSON.stringify(sourceIndex.sections)}\n</source_index>`,
    mediaPrompt,
  ].filter(Boolean).join('\n\n')
}

function buildPagePrompt(
  outline: DeckOutline,
  page: DeckOutlinePage,
  pageIndex: number,
  theme: ReturnType<typeof getPptdThemePreset>,
  design: PptdDesignSpec,
  planning: PptdPlanningDraft | undefined,
  evidence: string,
  mediaPrompt: string,
  referencePage?: string,
): string {
  return [
    `生成第 ${pageIndex + 1}/${outline.pages.length} 页。只返回一个 .page YAML 文档，不要代码围栏，不要解释。`,
    '页面尺寸固定为 960x540。安全边距至少 48。所有 bounds 必须是 [x,y,width,height] 且位于画布内。',
    '顶层只能包含 pageType、可选 background、elements。每个 elementId 在本页唯一。',
    'YAML 采用 Kimi PPTD 示例的紧凑风格：优先使用内联 map/数组，能使用 theme token 就不要重复写 fontSize、fontFamily 和 color；不要写注释、空字段或冗余装饰。',
    '常用文字样式使用 style: "$title"、style: "$subtitle"、style: "$body"、style: "$caption"；颜色优先使用 "$bg"、"$text"、"$muted"、"$accent" 等 token。',
    mediaPrompt
      ? '支持 text、shape、line、icon、table、chart、image。image 的 src 以及 background.type=image 的 src 只能逐字使用 media_catalog 中列出的本地 media/... 路径，禁止远程 URL。'
      : '支持 text、shape、line、icon、table、chart。当前没有可用图片，禁止生成 image 元素或远程 URL。',
    'text 元素格式示例：{elementId: title, elementType: text, bounds: [64,48,832,64], content: {text: "标题", fontSize: 32, color: "$text", bold: true}}。',
    '所有 content.text、label、title、value 等文本值必须用引号包裹；文本包含冒号、井号、美元符号或花括号时尤其如此，禁止裸写导致 YAML 解析失败。',
    '只有存在至少两条真实数值数据时才可使用 chart；SQL/组件映射、架构、流程、依赖和关系禁止使用 chart，必须用 shape、line、icon 与 text 表达。禁止生成只有坐标轴、空系列或全为 0 的图表。',
    isDiagramOutlinePage(page) ? '这是流程/架构/关系图页面。必须使用 3-8 个清晰节点和有向连接线：节点使用不小于 120x44 的 shape，节点之间至少留 24px；连接线使用 points + viewBox 绘制水平/垂直正交折线，末端必须设置 endArrow: triangle，连接线放在节点之前（zIndex: 0），节点放在连接线之后（zIndex: 1），不得穿过第三个节点、不得交叉、不得使用斜线。每条连接线必须从一个节点边缘连接到另一个节点边缘。节点文字单独放在节点内部并保持可读。' : '',
    isDiagramOutlinePage(page) ? '关系图页面禁止使用 chart、长段落、重叠卡片和裸文本箭头（如 ->、→）代替连接线；复杂架构请拆成 2-3 层或减少节点，不要把所有系统塞进一张图。' : '',
    '同页 text bounds 不得重叠。正文不小于 14pt，标题不小于 28pt。通过图表、表格、形状关系、细线和留白表达结构，禁止把 keyPoints 原样堆成大段项目符号。',
    '用页面结论所需的全部元素完成页面（通常 6-24 个）；不要删除表达层级、关系或证据所需的元素，也不要用冗余装饰消耗输出预算。',
    ['content', 'comparison', 'timeline', 'chart', 'table', 'summary'].includes(page.pageType)
      ? '正文类页面必须至少包含 6 个元素和至少 1 个非文本元素；标题、栏目名不能代替证据。page_outline 中每个 keyPoint 都要落为可读的解释、数值、表格、图表、节点关系或带标签的形状，不要只输出几个并列标题。'
      : '',
    '严格执行 visualTask、layout 和设计规范。每个元素都必须服务于本页结论；相邻页面不得机械重复相同版式。',
    `<design_spec>\n${JSON.stringify(compactDesignSpec(design))}\n</design_spec>`,
    `<theme>\n${JSON.stringify(compactTheme(theme))}\n</theme>`,
    planning ? `<planning_draft>\n${planningPromptBounds(planning, design)}\n</planning_draft>\n策划稿是页面结构约束。请将每张卡片的内容和层级落实为完整 PPTD 元素；suggestedBounds 由代码按网格计算，仅可在必要时做小幅调整，不得让元素重叠或越界。` : '',
    evidence ? `<page_evidence>\n${evidence}\n</page_evidence>` : '',
    `<page_outline>\n${JSON.stringify(page)}\n</page_outline>`,
    referencePage
      ? `<layout_reference_page>\n${clipReferencePage(referencePage)}\n</layout_reference_page>\n只借鉴该示例的构图密度、层级、网格和元素组合；不要复制示例中的产品名称、数字、来源、链接、媒体路径或事实。`
      : '',
    mediaPrompt,
  ].filter(Boolean).join('\n\n')
}

function isDiagramOutlinePage(page: DeckOutlinePage): boolean {
  const value = [page.pageType, page.intent, page.layout, page.visualTask, ...page.keyPoints].join(' ').toLowerCase()
  return /diagram|flow|process|architecture|sequence|dependency|pipeline|workflow|架构|流程|依赖|链路|组件映射|系统关系|数据流/.test(value)
}

function buildRepairPrompt(
  outline: DeckOutline,
  state: PageState,
  diagnostics: PptdDiagnostic[],
  theme: ReturnType<typeof getPptdThemePreset>,
  design: PptdDesignSpec,
  planning: PptdPlanningDraft | undefined,
  evidence: string,
  mediaPrompt: string,
  referencePage?: string,
): string {
  const compositionRepair = diagnostics.some((diagnostic) => diagnostic.code === 'composition-sparse')
  return [
    `修复第 ${state.pageIndex + 1}/${outline.pages.length} 页。只返回完整替换用的 .page YAML，不要代码围栏，不要解释。`,
    '沿用 Kimi PPTD 示例的紧凑 YAML：除 composition-sparse 之外，保留 current_page_snapshot 中全部 elementId、元素类型和视觉层级，只做诊断指出的最小修改；优先使用 style/token、内联 map/数组，不要把页面改写成简单项目符号页。',
    compositionRepair
      ? '本轮诊断是 composition-sparse，允许并且必须新增、删除、重排元素，重构为有证据结构的页面；不要为了保留全部 elementId 而维持原来的裸文本布局。正文页至少使用 6 个元素，并包含至少 1 个非文本元素。'
      : '',
    diagnostics.some((diagnostic) => diagnostic.code?.startsWith('diagram-'))
      ? '本轮诊断发现关系图几何错误。允许并且必须重排节点和连接线：节点至少 120x44、间距至少 24px；连接线必须是带 points/viewBox 的水平或垂直正交折线，endArrow: triangle，zIndex 低于节点，起止点连接节点边缘，不穿过第三节点，不与其他连接线交叉。可以删除并重建错误连接线，不要保留不可读的旧几何。'
      : '',
    mediaPrompt
      ? '保持本页结论和关键内容，做最小必要修改。所有 bounds 必须位于 960x540 内，text 元素不得重叠。image 只能引用 media_catalog 中列出的本地路径。'
      : '保持本页结论和关键内容，做最小必要修改。所有 bounds 必须位于 960x540 内，text 元素不得重叠。当前没有可用图片，禁止 image。',
    '所有文本标量必须用引号包裹，尤其是包含冒号、井号、美元符号或花括号的文本；输出必须是一个顶层对象，不能只输出 elements 数组。',
    '若问题来自架构、流程、组件映射或关系表达，不要修成 chart；用有标签的 shape、line、icon 和 text 表达方向、边界与依赖。chart 必须至少有两条真实数值数据且不能只剩坐标轴。',
    '修复不能抹掉原有视觉层级或改成项目符号文字页；继续遵守设计规范和 visualTask。',
    `<design_spec>\n${JSON.stringify(compactDesignSpec(design))}\n</design_spec>`,
    `<theme>\n${JSON.stringify(compactTheme(theme))}\n</theme>`,
    `<page_outline>\n${JSON.stringify(state.outline)}\n</page_outline>`,
    planning ? `<planning_draft>\n${planningPromptBounds(planning, design)}\n</planning_draft>\n修复时保持策划稿的主次结构，不要把页面退化为无证据的项目符号列表。` : '',
    evidence ? `<page_evidence>\n${evidence}\n</page_evidence>` : '',
    `<diagnostics>\n${formatDiagnostics(dedupeDiagnostics(diagnostics))}\n</diagnostics>`,
    `<current_page_snapshot>\n${repairPageSnapshot(state)}\n</current_page_snapshot>`,
    referencePage
      ? `<layout_reference_page>\n${clipReferencePage(referencePage)}\n</layout_reference_page>\n只借鉴构图密度、层级、网格和元素组合，不复制示例事实。`
      : '',
    mediaPrompt,
  ].filter(Boolean).join('\n\n')
}

function clipReferencePage(value: string): string {
  const text = value.trim()
  return text.length <= 12_000 ? text : `${text.slice(0, 12_000)}\n[...示例页面已截断，仅保留构图参考...]`
}

function compactDesignSpec(design: PptdDesignSpec): Pick<PptdDesignSpec, 'visualSignature' | 'palette' | 'typography' | 'layout' | 'compositionRules' | 'componentRules' | 'prohibited' | 'imageryStyle'> {
  const clip = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit)}...`
  const rules = (values: readonly string[]) => values.map((value) => clip(value, 180))
  return {
    visualSignature: clip(design.visualSignature, 240),
    palette: design.palette,
    typography: design.typography,
    layout: design.layout,
    compositionRules: rules(design.compositionRules),
    componentRules: rules(design.componentRules),
    prohibited: rules(design.prohibited),
    imageryStyle: clip(design.imageryStyle, 240),
  }
}

function compactTheme(theme: ReturnType<typeof getPptdThemePreset>): Pick<ReturnType<typeof getPptdThemePreset>, 'colors' | 'textStyles'> {
  return { colors: theme.colors, textStyles: theme.textStyles }
}

function repairPageSnapshot(state: PageState): string {
  if (state.parseError && state.raw.trim()) {
    const raw = state.raw.trim()
    return raw.length <= 16_000 ? raw : `${raw.slice(0, 16_000)}\n[...原始页面输出已截断，仅供定位...]`
  }
  const page = {
    ...state.page,
    elements: state.page.elements.map((element) => {
      if (!element.content || typeof element.content.text !== 'string') return element
      const content = { ...element.content }
      const text = content.text as string
      if (text.length > 1_200) content.text = `${text.slice(0, 1_200)}\n[...文本已截断，保持原意...]`
      return { ...element, content }
    }),
  }
  return JSON.stringify(page)
}

const CHECKPOINT_FIELD = 'x-solidify-checkpoint'

function checkpointRootFor(input: PptdDeckPipelineInput): string {
  return `.solidify/pptd-checkpoints/${checkpointSourceHash(input)}`
}

function checkpointSourceHash(input: PptdDeckPipelineInput): string {
  const media = Object.entries(input.media ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => ({
    path,
    size: value instanceof Uint8Array ? value.byteLength : value.length,
    edge: value instanceof Uint8Array
      ? [...value.slice(0, 16), ...value.slice(-16)]
      : `${value.slice(0, 64)}${value.slice(-64)}`,
  }))
  return stableHash(JSON.stringify({
    brief: input.brief,
    materials: input.materials ?? '',
    title: input.title ?? '',
    themeId: input.themeId ?? '',
    designSystemId: input.designSystemId ?? '',
    maxPages: input.maxPages ?? DEFAULT_MAX_PAGES,
    artifactPath: safeArtifactPath(input.artifactPath),
    attachmentSources: (input.attachmentSources ?? []).map((source) => ({
      id: source.id,
      name: source.name,
      size: source.text.length,
      edge: `${source.text.slice(0, 128)}${source.text.slice(-128)}`,
    })),
    media,
  }))
}

function checkpointPageHash(outline: DeckOutline, design: PptdDesignSpec, planning: PptdPlanningDraft | undefined, pageIndex: number): string {
  return stableHash(JSON.stringify({ outline: outline.pages[pageIndex], design, planning }))
}

function stableHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

async function loadCheckpointMetadata(
  loadCheckpoint: GeneratePptdDeckOptions['loadCheckpoint'],
  root: string,
  sourceHash: string,
): Promise<PptdCheckpointMetadata | undefined> {
  if (!loadCheckpoint) return undefined
  const raw = await loadCheckpoint(`${root}/deck.pptd`)
  if (!raw) return undefined
  try {
    const document = parseYaml(raw)
    if (!isRecord(document) || !isRecord(document[CHECKPOINT_FIELD])) return undefined
    const metadata = document[CHECKPOINT_FIELD]
    if (metadata.schemaVersion !== 1 || metadata.sourceHash !== sourceHash || !isRecord(metadata.design) || !isRecord(metadata.outline)) return undefined
    return metadata as unknown as PptdCheckpointMetadata
  } catch {
    return undefined
  }
}

async function saveCheckpointManifest(
  onCheckpoint: GeneratePptdDeckOptions['onCheckpoint'],
  root: string,
  sourceHash: string,
  design: PptdDesignSpec,
  outline: DeckOutline,
  planningDrafts: readonly PptdPlanningDraft[],
  theme: ReturnType<typeof getPptdThemePreset>,
  states: readonly PageState[],
  media: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  if (!onCheckpoint) return
  const project = assembleStates(outline.title, theme, states, media).project
  const content = dumpYaml({
    version: project.version,
    title: project.title,
    size: project.size,
    theme: project.theme,
    pages: project.pagePaths,
    [CHECKPOINT_FIELD]: { schemaVersion: 1, sourceHash, design, outline, planningDrafts: [...planningDrafts] } satisfies PptdCheckpointMetadata,
  }, { noRefs: true, lineWidth: -1 })
  await onCheckpoint({ path: `${root}/deck.pptd`, content, kind: 'manifest' })
}

async function savePageCheckpoint(
  onCheckpoint: GeneratePptdDeckOptions['onCheckpoint'],
  root: string,
  sourceHash: string,
  outline: DeckOutline,
  design: PptdDesignSpec,
  state: PageState,
  reusable: boolean,
): Promise<void> {
  if (!onCheckpoint) return
  const content = dumpYaml({
    ...state.page,
    [CHECKPOINT_FIELD]: {
      schemaVersion: 1,
      sourceHash,
      pageHash: checkpointPageHash(outline, design, state.planning, state.pageIndex),
      status: state.fallback ? 'fallback' : state.repaired ? 'repaired' : 'generated',
      reusable,
      attempts: state.attempts,
      reasons: dedupeDiagnostics(state.diagnostics).map((diagnostic) => diagnostic.message),
    },
  }, { noRefs: true, lineWidth: -1 })
  await onCheckpoint({ path: `${root}/${state.pagePath}`, content, kind: 'page', pageIndex: state.pageIndex })
}

interface CheckpointWriteQueue {
  enqueue(write: () => Promise<void>): void
  flush(): Promise<void>
}

function createCheckpointWriteQueue(): CheckpointWriteQueue {
  let tail = Promise.resolve()
  let failure: unknown
  return {
    enqueue(write) {
      // Preserve write ordering without occupying a model-generation worker.
      // A failure is surfaced at the stage boundary, before repair or delivery.
      tail = tail.then(write).catch((error) => {
        failure ??= error
      })
    },
    async flush() {
      await tail
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
    },
  }
}

async function restoreCheckpointPages(
  loadCheckpoint: GeneratePptdDeckOptions['loadCheckpoint'],
  root: string,
  sourceHash: string,
  outline: DeckOutline,
  design: PptdDesignSpec,
  planningDrafts: readonly PptdPlanningDraft[],
  theme: ReturnType<typeof getPptdThemePreset>,
): Promise<Array<PageState | undefined>> {
  if (!loadCheckpoint) return outline.pages.map(() => undefined)
  return Promise.all(outline.pages.map(async (pageOutline, pageIndex) => {
    const pagePath = pagePathFor(pageIndex)
    const raw = await loadCheckpoint(`${root}/${pagePath}`)
    if (!raw) return undefined
    try {
      const document = parseYaml(raw)
      if (!isRecord(document) || !isRecord(document[CHECKPOINT_FIELD])) return undefined
      const metadata = document[CHECKPOINT_FIELD]
      if (metadata.schemaVersion !== 1
        || metadata.sourceHash !== sourceHash
        || metadata.pageHash !== checkpointPageHash(outline, design, planningDrafts[pageIndex], pageIndex)
        || metadata.reusable !== true) return undefined
      const cleanDocument = { ...document }
      delete cleanDocument[CHECKPOINT_FIELD]
      const cleanRaw = dumpYaml(cleanDocument, { noRefs: true, lineWidth: -1 })
      const parsedPage = parseGeneratedPage(cleanRaw, pagePath, theme)
      const page = isDiagramOutlinePage(pageOutline) ? { ...parsedPage, pageType: 'diagram' } : parsedPage
      const reasons = Array.isArray(metadata.reasons)
        ? metadata.reasons.filter((reason): reason is string => typeof reason === 'string' && Boolean(reason.trim()))
        : []
      const status = metadata.status === 'fallback' ? 'fallback' : metadata.status === 'repaired' ? 'repaired' : 'generated'
      return {
        pageIndex,
        pagePath,
        outline: pageOutline,
        planning: planningDrafts[pageIndex],
        raw: cleanRaw,
        page,
        attempts: typeof metadata.attempts === 'number' && Number.isSafeInteger(metadata.attempts) ? metadata.attempts : 1,
        repaired: status === 'repaired',
        fallback: status === 'fallback',
        diagnostics: reasons.map((message) => pageDiagnostic(pagePath, message, 'checkpoint-diagnostic')),
      }
    } catch {
      return undefined
    }
  }))
}

function parseStoredPlanningDraft(value: unknown, page: DeckOutlinePage, pageIndex: number): PptdPlanningDraft {
  return parsePlanningDraft(JSON.stringify(value), page, pageIndex)
}

function preparePptdMedia(input: PptdDeckPipelineInput['media']): {
  values: Record<string, string | Uint8Array>
  images: PptdModelImage[]
} {
  const values: Record<string, string | Uint8Array> = {}
  const images: PptdModelImage[] = []
  let totalBytes = 0
  for (const [path, value] of Object.entries(input ?? {})) {
    if (!isSafeMediaPath(path)) throw new Error(`PPTD media 路径无效：${path}`)
    const dataUrl = pptdMediaDataUrl(value, path)
    if (!dataUrl) throw new Error(`PPTD 不支持该图片格式：${path}`)
    const bytes = mediaByteLength(value, dataUrl)
    if (bytes > MAX_MEDIA_FILE_BYTES) throw new Error(`PPTD 图片超过 15MB：${path}`)
    totalBytes += bytes
    if (totalBytes > MAX_MEDIA_TOTAL_BYTES) throw new Error('PPTD 图片总大小超过 40MB')
    values[path] = value
    images.push({ path, dataUrl })
  }
  return { values, images }
}

function buildMediaPrompt(images: readonly PptdModelImage[]): string {
  if (images.length === 0) return ''
  return [
    '<media_catalog>',
    ...images.map((image, index) => `${index + 1}. ${image.path}`),
    '</media_catalog>',
    '这些图片已随请求提供。按内容相关性选择，不要为了装饰强行使用；引用时 src 必须与目录路径完全一致。',
  ].join('\n')
}

function isSafeMediaPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('media/')
    && normalized.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
}

function mediaByteLength(value: string | Uint8Array, dataUrl: string): number {
  if (value instanceof Uint8Array) return value.byteLength
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  if (/;base64,/i.test(dataUrl.slice(0, comma + 1))) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor(payload.length * 3 / 4) - padding)
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength
  } catch {
    return payload.length
  }
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
  const candidates = [text]
  const extracted = extractJsonObject(text)
  if (extracted && extracted !== text) candidates.push(extracted)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next bounded candidate, then return a stable pipeline error.
    }
  }
  throw new Error('输出不是有效 JSON 对象（模型输出可能被截断或包含未转义字符串）')
}

function extractJsonObject(text: string): string | undefined {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (start < 0) start = index
      depth++
    } else if (char === '}' && start >= 0) {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
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

function mergeTokenUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const inputTokens = (current?.inputTokens ?? 0) + next.inputTokens
  const outputTokens = (current?.outputTokens ?? 0) + next.outputTokens
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

const REVIEW_SYSTEM_PROMPT = '你是 PPTD 视觉质量审查器。只根据截图检查布局事实，不评论主题内容正确性，不要求远程素材。输出 APPROVED 或按 elementId 给出可执行修复意见。'
