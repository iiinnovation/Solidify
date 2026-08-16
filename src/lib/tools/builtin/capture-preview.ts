import type { Tool } from '../types'
import { failure, success, errorMessage } from './helpers'

interface CapturePreviewInput { artifact_id?: string; page_index?: number; format?: 'png' | 'jpeg' }

export function selectPreviewElement(root: HTMLElement | null, pageIndex?: number): HTMLElement | null {
  if (!root) return null
  if (pageIndex === undefined) return root
  if (root.matches(`[data-pptd-page="${pageIndex}"]`)) return root
  return root.querySelector<HTMLElement>(`[data-pptd-page="${pageIndex}"]`)
}

export const capturePreviewTool: Tool<CapturePreviewInput> = {
  name: 'capture_preview',
  description: '截取当前 artifact 渲染结果为图片，用于视觉自检。',
  inputSchema: { type: 'object', properties: { artifact_id: { type: 'string' }, page_index: { type: 'integer', minimum: 0 }, format: { type: 'string', enum: ['png', 'jpeg'] } } },
  readOnly: true, concurrencySafe: false, destructive: false, requiresConfirmation: false,
  availability: 'always', permissions: ['screen:capture'], timeoutMs: 30_000,
  async execute(input, _ctx, signal) {
    if (signal.aborted) return failure('runtime', '预览截取已中断', true)
    if (typeof document === 'undefined') return failure('runtime', '当前环境不支持预览截取', false)
    const selector = input.artifact_id ? `[data-artifact-id="${CSS.escape(input.artifact_id)}"]` : '[data-artifact-content]'
    const root = document.querySelector<HTMLElement>(selector)
    const element = selectPreviewElement(root, input.page_index)
    if (!element) return failure('not_found', '没有找到可截取的活动 artifact', true)
    try {
      const html2canvas = (await import('html2canvas' as string)).default as (node: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>
      const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1 })
      const mime = input.format === 'jpeg' ? 'image/jpeg' : 'image/png'
      const imageDataUrl = canvas.toDataURL(mime, 0.92)
      return success(`已截取预览（${canvas.width}x${canvas.height}）`, { imageDataUrl, width: canvas.width, height: canvas.height, mime, pageIndex: input.page_index })
    } catch (error) { return failure('runtime', `无法截取预览：${errorMessage(error)}`) }
  },
  renderCall: () => '截取当前 artifact 预览',
}
