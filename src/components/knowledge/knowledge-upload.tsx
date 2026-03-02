/**
 * 知识库上传组件
 * 支持拖拽上传和文件选择
 */

import { useState, useRef } from 'react'
import { Upload, X, FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { validateFileSize } from '@/lib/file-extractor'
import { toast } from '@/stores/toast-store'

interface UploadFile {
  file: File
  id: string
  status: 'pending' | 'uploading' | 'success' | 'error'
  progress: number
  error?: string
}

interface KnowledgeUploadProps {
  projectId?: string
  onUploadComplete?: (ids: string[]) => void
  onUploadError?: (error: Error) => void
}

export function KnowledgeUpload({ projectId, onUploadComplete, onUploadError }: KnowledgeUploadProps) {
  const [files, setFiles] = useState<UploadFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const acceptedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ]

  const handleFileSelect = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return

    const validFiles: UploadFile[] = []
    const invalidFiles: string[] = []

    Array.from(selectedFiles).forEach(file => {
      // 验证文件类型
      if (!acceptedTypes.includes(file.type)) {
        invalidFiles.push(`${file.name} (不支持的文件类型)`)
        return
      }

      // 验证文件大小（10MB）
      if (!validateFileSize(file, 10)) {
        invalidFiles.push(`${file.name} (超过 10MB 限制)`)
        return
      }

      validFiles.push({
        file,
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        status: 'pending' as const,
        progress: 0,
      })
    })

    // 显示被拒绝的文件
    if (invalidFiles.length > 0) {
      toast.error(`以下文件无法上传：\n${invalidFiles.join('\n')}`)
    }

    if (validFiles.length > 0) {
      setFiles(prev => [...prev, ...validFiles])
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFileSelect(e.dataTransfer.files)
  }

  const handleRemoveFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  const handleUpload = async () => {
    const pendingFiles = files.filter(f => f.status === 'pending')
    if (pendingFiles.length === 0) return

    // 动态导入 RAG Provider
    const { getRAGProvider } = await import('@/lib/rag')
    const ragProvider = getRAGProvider()

    for (const uploadFile of pendingFiles) {
      try {
        // 更新状态为上传中
        setFiles(prev =>
          prev.map(f =>
            f.id === uploadFile.id
              ? { ...f, status: 'uploading' as const, progress: 0 }
              : f
          )
        )

        // 上传文件
        const ids = await ragProvider.uploadDocument(uploadFile.file, {
          projectId,
          sourceType: 'manual',
        })

        // 更新状态为成功
        setFiles(prev =>
          prev.map(f =>
            f.id === uploadFile.id
              ? { ...f, status: 'success' as const, progress: 100 }
              : f
          )
        )

        onUploadComplete?.(ids)
      } catch (error) {
        // 更新状态为失败
        setFiles(prev =>
          prev.map(f =>
            f.id === uploadFile.id
              ? {
                  ...f,
                  status: 'error' as const,
                  error: error instanceof Error ? error.message : 'Upload failed',
                }
              : f
          )
        )

        onUploadError?.(error instanceof Error ? error : new Error('Upload failed'))
      }
    }
  }

  const handleClearCompleted = () => {
    setFiles(prev => prev.filter(f => f.status !== 'success'))
  }

  const pendingCount = files.filter(f => f.status === 'pending').length
  const uploadingCount = files.filter(f => f.status === 'uploading').length
  const successCount = files.filter(f => f.status === 'success').length
  const errorCount = files.filter(f => f.status === 'error').length

  return (
    <div className="space-y-4">
      {/* 拖拽上传区域 */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          isDragging
            ? 'border-accent bg-accent-light'
            : 'border-border hover:border-accent hover:bg-accent-light/50'
        )}
      >
        <Upload size={48} strokeWidth={1.5} className="mx-auto mb-4 text-text-tertiary" />
        <p className="text-base font-medium text-text-primary mb-2">
          点击上传或拖拽文件到此处
        </p>
        <p className="text-sm text-text-tertiary">
          支持 PDF、DOCX、TXT、MD 格式，单文件最大 10MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
        />
      </div>

      {/* 文件列表 */}
      {files.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text-primary">
              已选择 {files.length} 个文件
              {successCount > 0 && (
                <span className="text-success ml-2">({successCount} 个已上传)</span>
              )}
              {errorCount > 0 && (
                <span className="text-error ml-2">({errorCount} 个失败)</span>
              )}
            </p>
            <div className="flex items-center gap-2">
              {successCount > 0 && (
                <Button variant="ghost" size="sm" onClick={handleClearCompleted}>
                  清除已完成
                </Button>
              )}
              {pendingCount > 0 && (
                <Button
                  size="sm"
                  onClick={handleUpload}
                  disabled={uploadingCount > 0}
                >
                  {uploadingCount > 0 ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      上传中 ({uploadingCount}/{pendingCount})
                    </>
                  ) : (
                    `上传 (${pendingCount})`
                  )}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {files.map((uploadFile) => (
              <div
                key={uploadFile.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface"
              >
                <FileText size={20} strokeWidth={1.75} className="text-text-tertiary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {uploadFile.file.name}
                  </p>
                  <p className="text-xs text-text-tertiary">
                    {(uploadFile.file.size / 1024).toFixed(1)} KB
                  </p>
                  {uploadFile.status === 'uploading' && (
                    <div className="mt-2 h-1 bg-background-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]"
                        style={{ width: '40%' }}
                      />
                    </div>
                  )}
                  {uploadFile.status === 'error' && uploadFile.error && (
                    <p className="text-xs text-error mt-1">{uploadFile.error}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {uploadFile.status === 'pending' && (
                    <span className="text-xs text-text-tertiary">待上传</span>
                  )}
                  {uploadFile.status === 'uploading' && (
                    <Loader2 size={16} className="text-accent animate-spin" />
                  )}
                  {uploadFile.status === 'success' && (
                    <span className="text-xs text-success">✓ 已上传</span>
                  )}
                  {uploadFile.status === 'error' && (
                    <span className="text-xs text-error">✗ 失败</span>
                  )}
                  {uploadFile.status !== 'uploading' && (
                    <button
                      onClick={() => handleRemoveFile(uploadFile.id)}
                      className="p-1 rounded hover:bg-surface-hover text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      <X size={16} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
