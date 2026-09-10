import type { FolderTaskItem } from '@/lib/folder-tasks/types'

/** Backend evidence stays read-only when the user edits the AI's findings. */
export function FolderTaskSource({ provenance }: { provenance: FolderTaskItem['provenance'] }) {
  const extraction = provenance.extraction
  if (!extraction) return null
  return <aside aria-label="OCR 来源" className="mt-2 rounded-md border border-border-light p-3 text-xs text-text-secondary">
    <p>OCR 已处理 {extraction.pages.length} 页{extraction.complete ? '' : '（页面不完整）'}。识别内容仍需核对。</p>
    {extraction.warnings.length > 0 && <ul className="mt-1 list-inside list-disc">
      {extraction.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
    </ul>}
    <details className="mt-2">
      <summary className="cursor-pointer">查看原文来源</summary>
      <dl className="mt-2 space-y-1 break-all">
        <div><dt>文件</dt><dd>{provenance.relativePath}</dd></div>
        <div><dt>文件 SHA-256</dt><dd>{provenance.sourceHash}</dd></div>
        <div><dt>已处理页码</dt><dd>{extraction.pages.join('、')}</dd></div>
        <div><dt>识别版本</dt><dd>{extraction.parserVersion}</dd></div>
        <div><dt>语言包版本</dt><dd>{extraction.languageVersions.join('；')}</dd></div>
      </dl>
    </details>
  </aside>
}
