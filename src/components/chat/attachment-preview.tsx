import { FileIcon, X } from 'lucide-react'
import { formatFileSize } from '@/lib/file-extractor'

interface AttachmentPreviewProps {
  files: File[]
  onRemove: (index: number) => void
}

export function AttachmentPreview({ files, onRemove }: AttachmentPreviewProps) {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2 px-1">
      {files.map((file, index) => (
        <div
          key={index}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        >
          <FileIcon size={16} className="text-text-tertiary shrink-0" />
          <span className="text-text-primary truncate max-w-[200px]">
            {file.name}
          </span>
          <span className="text-text-tertiary text-xs shrink-0">
            {formatFileSize(file.size)}
          </span>
          <button
            onClick={() => onRemove(index)}
            className="ml-1 text-text-tertiary hover:text-error transition-colors shrink-0"
            title="移除"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
