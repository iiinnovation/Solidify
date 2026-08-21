import type { Tool } from '../types'
import { failure, success, errorMessage } from './helpers'

interface CapturePreviewInput { artifact_id?: string; page_index?: number; format?: 'png' | 'jpeg' }

/**
 * Whether a capture can succeed depends on what the artifact panel currently
 * renders — UI state the model neither observes nor controls. So a miss must
 * say which cause it hit, and whether calling again could ever change it.
 * Retrying an environmental miss burns a full model turn per attempt for a
 * result that is fixed before the tool is even reached.
 */
export type PreviewTarget =
  | { kind: 'element'; element: HTMLElement }
  | { kind: 'miss'; message: string; correctable: boolean }

export function selectPreviewElement(root: HTMLElement | null, pageIndex?: number): HTMLElement | null {
  if (!root) return null
  if (pageIndex === undefined) return root
  if (root.matches(`[data-pptd-page="${pageIndex}"]`)) return root
  return root.querySelector<HTMLElement>(`[data-pptd-page="${pageIndex}"]`)
}

const NO_RETRY = '截图结果由界面渲染状态决定，重复调用不会改变它。请不要再调用 capture_preview，直接输出内容。'

export function diagnosePreviewTarget(scope: ParentNode, input: CapturePreviewInput): PreviewTarget {
  const roots = [...scope.querySelectorAll<HTMLElement>('[data-artifact-content]')]
  if (roots.length === 0) {
    return {
      kind: 'miss',
      correctable: false,
      message: `当前没有已渲染的 artifact 预览：预览面板未打开，或本次运行尚未产出 artifact。${NO_RETRY}`,
    }
  }

  const root = input.artifact_id
    ? scope.querySelector<HTMLElement>(`[data-artifact-id="${CSS.escape(input.artifact_id)}"]`)
    : roots[0]
  if (!root) {
    const available = [...new Set(roots
      .map((candidate) => candidate.getAttribute('data-artifact-id'))
      .filter((id): id is string => Boolean(id)))]
    // Only the artifact on the active tab is in the DOM. Naming what is there
    // lets the model retarget instead of repeating the same failing id.
    const shown = available.length > 0
      ? `当前预览中的 artifact 为：${available.join('、')}。可以省略 artifact_id 截取当前预览。`
      : '当前预览的 artifact 没有暴露 id。请省略 artifact_id 截取当前预览。'
    return { kind: 'miss', correctable: true, message: `artifact ${input.artifact_id} 不在当前预览中。${shown}` }
  }

  const element = selectPreviewElement(root, input.page_index)
  if (!element) {
    const pages = [...root.querySelectorAll('[data-pptd-page]')].length
      + (root.matches('[data-pptd-page]') ? 1 : 0)
    // A bad page index is the model's own argument error, so it stays
    // correctable — unlike a missing panel, a different index can succeed.
    return pages > 0
      ? { kind: 'miss', correctable: true, message: `该 artifact 没有第 ${input.page_index} 页：共 ${pages} 页，page_index 从 0 开始。` }
      : { kind: 'miss', correctable: false, message: `该 artifact 不是分页内容，不支持 page_index。省略 page_index 可截取整个预览。` }
  }
  return { kind: 'element', element }
}

export const capturePreviewTool: Tool<CapturePreviewInput> = {
  name: 'capture_preview',
  description: '截取当前 artifact 渲染结果为图片，用于视觉自检。只有 artifact 已在预览面板渲染时可用。',
  inputSchema: { type: 'object', properties: { artifact_id: { type: 'string' }, page_index: { type: 'integer', minimum: 0 }, format: { type: 'string', enum: ['png', 'jpeg'] } } },
  readOnly: true, concurrencySafe: false, destructive: false, requiresConfirmation: false,
  availability: 'always', permissions: ['screen:capture'], timeoutMs: 30_000,
  // A capture depends on render state, not on arguments, so repeated calls are
  // a loop by construction. Let the shared guard close it deterministically
  // rather than relying on the generic consecutive-failure breaker.
  loopGroup: 'artifact-capture',
  async execute(input, _ctx, signal) {
    if (signal.aborted) return failure('runtime', '预览截取已中断', true)
    if (typeof document === 'undefined') return failure('runtime', '当前环境不支持预览截取', false)
    const target = diagnosePreviewTarget(document, input)
    if (target.kind === 'miss') return failure('not_found', target.message, target.correctable)
    try {
      const html2canvas = (await import('html2canvas' as string)).default as (node: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>
      const canvas = await html2canvas(target.element, { backgroundColor: '#ffffff', scale: 1 })
      const mime = input.format === 'jpeg' ? 'image/jpeg' : 'image/png'
      const imageDataUrl = canvas.toDataURL(mime, 0.92)
      return success(`已截取预览（${canvas.width}x${canvas.height}）`, { imageDataUrl, width: canvas.width, height: canvas.height, mime, pageIndex: input.page_index })
    } catch (error) { return failure('runtime', `无法截取预览：${errorMessage(error)}`) }
  },
  renderCall: () => '截取当前 artifact 预览',
}
