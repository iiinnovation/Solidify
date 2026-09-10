import { useEffect, useState } from 'react'
import { folderTaskClient } from '@/lib/folder-tasks/client'
import type { SandboxMethodCapability } from '@/lib/folder-tasks/sandbox'
import { OcrPackagePreparation } from './ocr-package-preparation'

/** Status only: never equate a recognized extension with installed components. */
export function FolderTaskOcrStatus({ taskId }: { taskId: string }) {
  const [capabilities, setCapabilities] = useState<readonly SandboxMethodCapability[] | null>(null)
  useEffect(() => {
    let active = true
    let revision = 0
    const refresh = async () => {
      const request = ++revision
      setCapabilities(null)
      try {
        const result = await folderTaskClient.sandboxCapabilities()
        if (active && request === revision) setCapabilities(result)
      } catch {
        if (active && request === revision) setCapabilities([])
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [taskId])
  return <section className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-xs text-text-secondary">
    <h3 className="font-medium text-text-primary">OCR 组件状态</h3>
    {capabilities === null ? <p className="mt-2">正在检查本机转换能力…</p> : (
      <div className="mt-2 space-y-1">
        {(['image_ocr', 'pdf_ocr'] as const).map((method) => {
          const capability = capabilities.find((item) => item.method === method)
          return <p key={method}>{method === 'image_ocr' ? '图片 OCR' : '扫描 PDF OCR'}：{capability?.available
            ? '组件就绪（仍需文件及批次校验）'
            : `不可用 — ${capability?.reason || '无法确认组件及隔离能力'}`}</p>
        })}
      </div>
    )}
    <p className="mt-2">缺少组件的文件保留为“待转换”。组件就绪不会自动重试或重新纳入已跳过文件；原计划排除的格式需要重新确认范围。</p>
    <OcrPackagePreparation />
  </section>
}
