import type { QueryContext } from '../../engine/types'
import { PPTD_DESIGN_SYSTEM_IDS } from '../../pptd/design-resources'
import { pptdMediaDataUrl } from '../../pptd/media'
import { runPptdDeckPipeline, type PptdDeckPipelineResult } from '../../pptd/pipeline'
import { PPTD_THEME_IDS, type PptdThemeId } from '../../pptd/theme-presets'
import { readWorkspaceBytes, readWorkspaceFile, writeWorkspaceFile } from '@/lib/tauri'
import type { Tool } from '../types'

export interface GeneratePptdInput {
  brief: string
  materials?: string
  attachmentIds?: string[]
  title?: string
  themeId?: PptdThemeId
  designSystemId?: string
  mediaPaths?: string[]
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
  // A deck generation owns a large, stateful model pipeline. Retrying the
  // whole tool after a timeout would silently start all pages from scratch;
  // keep the Skill's "call exactly once" contract enforceable at runtime.
  let started = false
  return {
    name: 'generate_pptd',
    description: [
      'Generate one complete PPTD deck from a prepared brief and source materials.',
      'Use this exactly once after reading all relevant workspace files and references.',
      'Use attachmentIds for user-uploaded source material; do not paste whole attachments into materials.',
      'The tool performs design direction, outline generation, per-page planning drafts, bounded parallel page generation, validation, targeted repair, and emits the final slides artifact directly.',
      'It includes an art-direction stage backed by the bundled open-kimi-ppt scenario guides, design systems, and reference pages.',
      'Do not generate page YAML yourself before or after calling it.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: {
        brief: { type: 'string', minLength: 1, maxLength: 20_000 },
        materials: { type: 'string', maxLength: 20_000 },
        attachmentIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        themeId: { type: 'string', enum: [...PPTD_THEME_IDS] },
        designSystemId: { type: 'string', enum: [...PPTD_DESIGN_SYSTEM_IDS] },
        mediaPaths: {
          type: 'array', maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 240 },
        },
        maxPages: { type: 'integer', minimum: 1, maximum: 24 },
        artifactPath: { type: 'string', minLength: 1, maxLength: 240 },
      },
    },
    // With a selected desktop workspace the tool persists resumable checkpoints
    // under .solidify; the final user-facing artifact is still materialized by chat.
    readOnly: false,
    concurrencySafe: false,
    destructive: false,
    requiresConfirmation: false,
    availability: 'online-only',
    permissions: ['fs:write'],
    timeoutMs: GENERATE_PPTD_TIMEOUT_MS,
    async execute(input, ctx, signal, onProgress) {
      if (started) throw new Error('本次运行已启动过 generate_pptd；请等待已有生成结束，不要从头重复生成。')
      started = true
      try {
        const parent = getParent()
        const availableAttachmentIds = new Set((parent.attachments ?? []).map((attachment) => attachment.id))
        const requestedAttachmentIds = [...new Set(input.attachmentIds ?? [])]
        if ((parent.attachments?.length ?? 0) > 0 && input.attachmentIds === undefined) {
          throw new Error('当前运行存在附件；请先使用附件 manifest 中的 ID，并通过 attachmentIds 显式选择来源。')
        }
        const missingAttachmentIds = requestedAttachmentIds.filter((id) => !availableAttachmentIds.has(id))
        if (missingAttachmentIds.length > 0) {
          throw new Error(`附件不存在或不属于当前运行：${missingAttachmentIds.join(', ')}`)
        }
        const workspaceMedia = await loadWorkspaceMedia(input.mediaPaths, parent, signal)
        const checkpointIO = parent.workspace ? {
          async onCheckpoint(checkpoint: { path: string; content: string }) {
            parent.workspace!.resolve(checkpoint.path)
            await writeWorkspaceFile(checkpoint.path, checkpoint.content, parent.cwd)
          },
          async loadCheckpoint(path: string) {
            parent.workspace!.resolve(path)
            try {
              const result = await readWorkspaceFile(path, parent.cwd)
              return result.binary || result.truncated ? undefined : result.content ?? undefined
            } catch (error) {
              if (isMissingCheckpoint(error)) return undefined
              throw error
            }
          },
        } : {}
        const result = await runPptdDeckPipeline(parent, {
          ...input,
          attachmentSources: (parent.attachments ?? [])
            .filter((attachment) => requestedAttachmentIds.includes(attachment.id))
            .filter((attachment): attachment is typeof attachment & { text: string } => typeof attachment.text === 'string')
            .map((attachment) => ({ id: attachment.id, name: attachment.name, text: attachment.text })),
          media: { ...(parent.pptdMedia ?? {}), ...workspaceMedia },
        }, {
          signal,
          ...checkpointIO,
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
      } catch (error) {
        // A failed pipeline did not produce a deliverable. Allow a fresh call
        // on this tool instance so a caller can adjust the brief and retry;
        // successful generation remains one-shot and stays locked.
        started = false
        throw error
      }
    },
    renderCall(input) {
      return `生成 PPTD 演示文稿${input.title ? `：${input.title}` : ''}`
    },
  }
}

const MAX_MEDIA_FILE_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_TOTAL_BYTES = 40 * 1024 * 1024

async function loadWorkspaceMedia(
  paths: readonly string[] | undefined,
  context: QueryContext,
  signal: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  if (!paths?.length) return {}
  if (!context.workspace) throw new Error('mediaPaths 只能读取已选择工作区中的图片')
  const media: Record<string, Uint8Array> = {}
  let totalBytes = 0
  for (const [index, path] of paths.entries()) {
    if (signal.aborted) throw new DOMException('PPTD 媒体读取已中断', 'AbortError')
    context.workspace.resolve(path)
    const bytes = new Uint8Array(await readWorkspaceBytes(path, context.cwd))
    if (bytes.byteLength > MAX_MEDIA_FILE_BYTES) throw new Error(`PPTD 图片超过 15MB：${path}`)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_MEDIA_TOTAL_BYTES) throw new Error('PPTD 图片总大小超过 40MB')
    if (!pptdMediaDataUrl(bytes, path)) throw new Error(`PPTD 不支持该图片格式：${path}`)
    const baseName = path.replace(/\\/g, '/').split('/').pop()?.replace(/[^a-zA-Z0-9._-]+/g, '-') || `image-${index + 1}`
    const mediaPath = uniqueMediaPath({ ...(context.pptdMedia ?? {}), ...media }, `media/${baseName}`)
    media[mediaPath] = bytes
  }
  return media
}

function uniqueMediaPath(media: Readonly<Record<string, unknown>>, requested: string): string {
  if (!(requested in media)) return requested
  const dot = requested.lastIndexOf('.')
  const stem = dot > requested.lastIndexOf('/') ? requested.slice(0, dot) : requested
  const extension = dot > requested.lastIndexOf('/') ? requested.slice(dot) : ''
  let index = 2
  while (`${stem}-${index}${extension}` in media) index++
  return `${stem}-${index}${extension}`
}

function isMissingCheckpoint(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('not found') || message.includes('no such file') || message.includes('不存在')
}
