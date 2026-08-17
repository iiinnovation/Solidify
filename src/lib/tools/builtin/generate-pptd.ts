import type { QueryContext } from '../../engine/types'
import { runPptdDeckPipeline, type PptdDeckPipelineResult } from '../../pptd/pipeline'
import { PPTD_THEME_IDS, type PptdThemeId } from '../../pptd/theme-presets'
import type { Tool } from '../types'

export interface GeneratePptdInput {
  brief: string
  materials?: string
  title?: string
  themeId?: PptdThemeId
  maxPages?: number
  artifactPath?: string
}

export interface GeneratePptdOutput {
  directAssistantContent: true
  contentHandle: string
  artifact: { title: string; type: 'slides'; path: string }
  pageReports: Array<{ pageIndex: number; status: 'generated' | 'repaired' | 'fallback'; attempts: number }>
  warnings: string[]
  usage: PptdDeckPipelineResult['usage']
}

export const GENERATE_PPTD_TIMEOUT_MS = 30 * 60_000

/** Dynamic because the pipeline must use the active run's provider and budget. */
export function createGeneratePptdTool(getParent: () => QueryContext): Tool<GeneratePptdInput, GeneratePptdOutput> {
  return {
    name: 'generate_pptd',
    description: [
      'Generate one complete PPTD deck from a prepared brief and source materials.',
      'Use this exactly once after reading all relevant workspace files and references.',
      'The tool performs outline generation, bounded parallel page generation, validation, targeted repair, and emits the final slides artifact directly.',
      'Do not generate page YAML yourself before or after calling it.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: {
        brief: { type: 'string', minLength: 1, maxLength: 20_000 },
        materials: { type: 'string', maxLength: 80_000 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        themeId: { type: 'string', enum: [...PPTD_THEME_IDS] },
        maxPages: { type: 'integer', minimum: 1, maximum: 24 },
        artifactPath: { type: 'string', minLength: 1, maxLength: 240 },
      },
    },
    // Model inference changes no external state; the resulting artifact is
    // materialized later by the existing chat artifact path.
    readOnly: true,
    concurrencySafe: false,
    destructive: false,
    requiresConfirmation: false,
    availability: 'online-only',
    permissions: [],
    timeoutMs: GENERATE_PPTD_TIMEOUT_MS,
    async execute(input, ctx, signal, onProgress) {
      const result = await runPptdDeckPipeline(getParent(), input, {
        signal,
        onProgress(progress) {
          onProgress?.({
            phase: `pptd_${progress.stage}`,
            current: progress.current,
            total: progress.total,
            message: progress.message,
            detail: progress,
          })
        },
      })
      const contentHandle = await ctx.memory.store(result.artifact.envelope)
      const output: GeneratePptdOutput = {
        directAssistantContent: true,
        contentHandle,
        artifact: {
          title: result.artifact.title,
          type: result.artifact.type,
          path: result.artifact.path,
        },
        pageReports: result.pageReports.map(({ pageIndex, status, attempts }) => ({ pageIndex, status, attempts })),
        warnings: result.warnings,
        usage: result.usage,
      }
      return {
        success: true,
        content: JSON.stringify({
          summary: `PPTD deck generated: ${result.project.pages.length} pages`,
          artifact: output.artifact,
          pageReports: output.pageReports,
          warnings: output.warnings,
          contentHandle,
        }),
        data: output,
      }
    },
    renderCall(input) {
      return `生成 PPTD 演示文稿${input.title ? `：${input.title}` : ''}`
    },
  }
}
