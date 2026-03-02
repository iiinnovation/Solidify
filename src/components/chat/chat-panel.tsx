import { useState, useRef, useEffect, useCallback } from 'react'
import { SendHorizonal, Square, FileText, Code, Presentation, GitGraph, ChevronDown, Settings2, Copy, RefreshCw, X, Paperclip, FileIcon, AlertCircle, BookOpen, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/components/artifacts/markdown-renderer'
import { useChatStore, type ArtifactType } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useUIStore } from '@/stores/ui-store'
import { useChat } from '@/hooks/use-chat'
import { useSkillPalette } from '@/hooks/use-skill-palette'
import { SkillPalette } from '@/components/chat/skill-palette'
import { AttachmentPreview } from '@/components/chat/attachment-preview'
import { TemplateVariableForm } from '@/components/templates/template-variable-form'
import { toast } from '@/stores/toast-store'
import { isTauri, openFileDialog, readBinaryFile } from '@/lib/tauri'
import { validateFileSize, validateFileType, formatFileSize } from '@/lib/file-extractor'
import type { Template } from '@/lib/api/types'
import { useIncrementTemplateUsage } from '@/hooks/use-templates'

const typeIcons: Record<ArtifactType, typeof FileText> = {
  document: FileText,
  code: Code,
  slides: Presentation,
  mermaid: GitGraph,
  chart: GitGraph,
  drawio: GitGraph,
}

const typeLabels: Record<ArtifactType, string> = {
  document: '文档',
  code: '代码预览',
  slides: '幻灯片',
  mermaid: '流程图',
  chart: '数据图表',
  drawio: 'Draw.io 流程图',
}

function ArtifactRefCard({ messageId }: { messageId: string }) {
  const { artifacts, setActiveArtifact, activeArtifactId } = useChatStore()
  const messageArtifacts = artifacts.filter((a) => a.messageId === messageId)

  if (messageArtifacts.length === 0) return null

  return (
    <>
      {messageArtifacts.map((artifact) => {
        // 防护：处理旧数据中可能存在的未知类型
        const Icon = typeIcons[artifact.type] || FileText
        const label = typeLabels[artifact.type] || '未知类型'
        const isActive = activeArtifactId === artifact.id
        return (
          <button
            key={artifact.id}
            onClick={() => setActiveArtifact(artifact.id)}
            className={cn(
              "mt-3 w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all",
              isActive
                ? "border-accent bg-accent-light"
                : "border-border bg-surface hover:border-border-focus hover:shadow-xs"
            )}
          >
            <div className={cn(
              "w-8 h-8 rounded-md flex items-center justify-center shrink-0",
              isActive ? "bg-accent/10 text-accent" : "bg-background-secondary text-text-tertiary"
            )}>
              <Icon size={16} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{artifact.title}</p>
              <p className="text-xs text-text-tertiary mt-0.5">{label}</p>
            </div>
          </button>
        )
      })}
    </>
  )
}

function KnowledgeSourcesCard({ sources }: { sources: Array<{ id: string; title: string; similarity: number }> }) {
  if (sources.length === 0) return null

  return (
    <div className="mt-3 w-full px-4 py-3 rounded-lg border border-border bg-surface/50">
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={14} className="text-accent shrink-0" strokeWidth={1.75} />
        <p className="text-xs font-medium text-text-secondary">引用知识库</p>
      </div>
      <div className="space-y-1.5">
        {sources.map((source, index) => (
          <div key={source.id} className="flex items-center gap-2 text-xs">
            <span className="text-text-tertiary shrink-0">[{index + 1}]</span>
            <span className="text-text-primary truncate flex-1">{source.title}</span>
            <span className="text-text-tertiary shrink-0">
              {Math.round(source.similarity * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelSelector() {
  const navigate = useNavigate()
  const { providers, activeProviderId, setActiveProvider } = useModelStore()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const activeProvider = providers.find((p) => p.id === activeProviderId)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  if (providers.length === 0) {
    return (
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-accent transition-colors"
      >
        <Settings2 size={12} strokeWidth={1.75} />
        <span>配置模型</span>
      </button>
    )
  }

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <span className="max-w-[160px] truncate">{activeProvider?.name ?? '选择模型'}</span>
        <ChevronDown size={12} strokeWidth={1.75} className={cn("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-56 rounded-lg border border-border bg-surface shadow-md py-1 z-50">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => {
                setActiveProvider(provider.id)
                setOpen(false)
              }}
              className={cn(
                "w-full text-left px-3 py-2 hover:bg-background-secondary transition-colors",
                provider.id === activeProviderId && "bg-accent-light"
              )}
            >
              <p className="text-sm text-text-primary truncate">{provider.name}</p>
              <p className="text-xs text-text-tertiary font-mono truncate">{provider.modelId}</p>
            </button>
          ))}
          <div className="border-t border-border-light mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false)
                navigate('/settings')
              }}
              className="w-full text-left px-3 py-2 hover:bg-background-secondary transition-colors flex items-center gap-1.5 text-xs text-text-tertiary"
            >
              <Settings2 size={12} strokeWidth={1.75} />
              管理模型配置
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function StreamingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:150ms]" />
      <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:300ms]" />
    </div>
  )
}

function MessageActions({
  content,
  role,
  isLast,
  onRegenerate,
  isStreaming
}: {
  content: string
  role: 'user' | 'assistant'
  isLast: boolean
  onRegenerate?: () => void
  isStreaming: boolean
}) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      toast.success('已复制到剪贴板')
    } catch {
      toast.error('复制失败')
    }
  }

  if (!content) return null

  return (
    <div className={cn(
      "flex items-center gap-1 mt-2",
      role === 'user' ? "justify-end" : "justify-start"
    )}>
      <button
        onClick={handleCopy}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="复制"
      >
        <Copy size={14} strokeWidth={1.75} />
      </button>
      {role === 'assistant' && isLast && !isStreaming && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title="重新生成"
        >
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}

export function ChatPanel({ conversationId }: { conversationId?: string }) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [templateFormOpen, setTemplateFormOpen] = useState(false)
  const { messages, isStreaming, error, sendMessage, stopStreaming, regenerate, retry } = useChat(conversationId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isNearBottomRef = useRef(true)
  const incrementUsageMutation = useIncrementTemplateUsage()

  const { enabled: knowledgeEnabled, setEnabled: setKnowledgeEnabled } = useKnowledgeEnhancementStore()
  const { pendingInput, setPendingInput } = useUIStore()

  // 从模板页面接收 pendingInput
  useEffect(() => {
    if (pendingInput) {
      setInput(pendingInput)
      setPendingInput(null)
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [pendingInput, setPendingInput])

  const {
    isOpen: isPaletteOpen,
    selectedIndex: paletteIndex,
    activeSkill,
    filteredSkills,
    handleInputChange: onPaletteInputChange,
    selectSkill,
    clearSkill,
    handleKeyDown: onPaletteKeyDown,
  } = useSkillPalette()

  const { providers, activeProviderId } = useModelStore()
  const activeProvider = providers.find((p) => p.id === activeProviderId)

  // 检测当前模型是否匹配技能推荐
  const isModelMismatch = activeSkill?.recommendedModels &&
    activeSkill.recommendedModels.length > 0 &&
    !activeSkill.recommendedModels.some(m =>
      activeProvider?.name.toLowerCase().includes(m.toLowerCase())
    )

  // 智能自动滚动：仅在用户靠近底部时自动滚动
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  useEffect(() => {
    if (scrollRef.current && isNearBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleFileSelect = async () => {
    if (isTauri) {
      // Tauri: 使用原生对话框
      const paths = await openFileDialog({
        multiple: true,
        filters: [
          { name: '文档', extensions: ['pdf', 'docx', 'txt', 'md'] },
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: '表格', extensions: ['xlsx', 'csv'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })

      if (paths) {
        const pathArray = Array.isArray(paths) ? paths : [paths]
        const files: File[] = []

        for (const path of pathArray) {
          try {
            const data = await readBinaryFile(path)
            if (data) {
              const fileName = path.split('/').pop() || path.split('\\').pop() || 'file'
              const file = new File([data as unknown as BlobPart], fileName)

              if (!validateFileType(file)) {
                toast.error(`不支持的文件类型: ${fileName}`)
                continue
              }
              if (!validateFileSize(file)) {
                toast.error(`文件过大 (最大 10MB): ${fileName}`)
                continue
              }

              files.push(file)
            }
          } catch (error) {
            console.error('读取文件失败:', error)
          }
        }

        if (files.length > 0) {
          setAttachments(prev => [...prev, ...files])
        }
      }
    } else {
      // Web: 触发 input[type=file]
      fileInputRef.current?.click()
    }
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const validFiles: File[] = []

    for (const file of files) {
      if (!validateFileType(file)) {
        toast.error(`不支持的文件类型: ${file.name}`)
        continue
      }
      if (!validateFileSize(file)) {
        toast.error(`文件过大 (最大 10MB): ${file.name}`)
        continue
      }
      validFiles.push(file)
    }

    if (validFiles.length > 0) {
      setAttachments(prev => [...prev, ...validFiles])
    }

    // 重置 input
    if (e.target) {
      e.target.value = ''
    }
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const handleSend = () => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    isNearBottomRef.current = true
    sendMessage(text, attachments.length > 0 ? attachments : undefined, activeSkill?.systemPrompt, activeSkill?.skipConfirmation)
    clearSkill()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let skill palette handle keys first when open
    const cursorPos = textareaRef.current?.selectionStart ?? input.length
    const result = onPaletteKeyDown(e, input, cursorPos)
    if (result.handled) {
      e.preventDefault()
      if (result.newInput !== undefined) {
        setInput(result.newInput)
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInputChangeLocal = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    const cursorPos = e.target.selectionStart ?? value.length
    onPaletteInputChange(value, cursorPos)
  }

  const handleTemplateSelect = (template: Template) => {
    setSelectedTemplate(template)
    setTemplateFormOpen(true)
  }

  const handleTemplateSubmit = (content: string) => {
    if (selectedTemplate) {
      incrementUsageMutation.mutate(selectedTemplate.id)
      setInput(content)
      setTemplateFormOpen(false)
      setSelectedTemplate(null)
      // 自动聚焦到输入框
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 100)
    }
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 消息列表 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
          {messages.length === 0 && !isStreaming && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center space-y-3">
                <p className="text-lg font-medium text-text-primary">有什么可以帮你的？</p>
                <p className="text-sm text-text-tertiary">描述你的项目需求，我来帮你分析和生成方案</p>
              </div>
            </div>
          )}

          {messages.map((msg, index) => (
            <div
              key={msg.id}
              className={cn(
                "group",
                msg.role === 'user' ? 'flex flex-col items-end' : 'flex flex-col items-start'
              )}
            >
              <div
                className={cn(
                  msg.role === 'user'
                    ? 'bg-accent-light rounded-lg rounded-br-sm px-4 py-3 max-w-[85%]'
                    : 'py-3 max-w-full w-full'
                )}
              >
                {msg.role === 'user' ? (
                  <>
                    <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
                      {msg.content}
                    </p>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {msg.attachments.map((att, idx) => (
                          <button
                            key={idx}
                            onClick={() => {
                              // 创建一个临时 artifact 来显示文件内容
                              const fileArtifact = {
                                id: `file-${msg.id}-${idx}`,
                                title: att.name,
                                type: 'document' as ArtifactType,
                                content: `# ${att.name}\n\n文件大小: ${formatFileSize(att.size)}\n\n*文件内容已在发送时提取并包含在消息中*`,
                                messageId: msg.id,
                                version: 1,
                              }
                              useChatStore.getState().addArtifact(fileArtifact)
                              useChatStore.getState().setActiveArtifact(fileArtifact.id)
                            }}
                            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
                          >
                            <FileIcon size={14} className="text-text-tertiary shrink-0" strokeWidth={1.75} />
                            <span className="truncate underline decoration-dotted underline-offset-2">{att.name}</span>
                            <span className="text-text-tertiary shrink-0">({formatFileSize(att.size)})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {msg.content ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : (
                      isStreaming && <StreamingIndicator />
                    )}
                    <ArtifactRefCard messageId={msg.id} />
                    {msg.knowledgeSources && msg.knowledgeSources.length > 0 && (
                      <KnowledgeSourcesCard sources={msg.knowledgeSources} />
                    )}
                  </>
                )}
              </div>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                <MessageActions
                  content={msg.content}
                  role={msg.role}
                  isLast={index === messages.length - 1}
                  onRegenerate={regenerate}
                  isStreaming={isStreaming}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-6">
          <div className="max-w-2xl mx-auto bg-error-light border border-error/20 rounded-lg px-4 py-2 flex items-center justify-between gap-3">
            <p className="text-sm text-error min-w-0 truncate">{error.message}</p>
            <button
              onClick={retry}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium text-error hover:bg-error/10 transition-colors"
            >
              <RefreshCw size={12} strokeWidth={2} />
              重试
            </button>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 px-6 pb-6 pt-2">
        <div className="max-w-2xl mx-auto">
          <div className="mb-1.5 pl-1 flex items-center justify-between">
            <ModelSelector />
            <button
              onClick={() => setKnowledgeEnabled(!knowledgeEnabled)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
                knowledgeEnabled
                  ? "bg-accent-light text-accent hover:bg-accent/20"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
              )}
              title={knowledgeEnabled ? "知识库增强已启用" : "知识库增强已禁用"}
            >
              <Sparkles size={12} strokeWidth={1.75} />
              <span>知识库</span>
            </button>
          </div>
          <div className="relative">
          {/* 隐藏的文件输入（Web 端） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.xlsx,.csv"
            className="hidden"
            onChange={handleFileInputChange}
          />
          {/* Skill badge */}
          {activeSkill && (
            <div className="flex items-center gap-1.5 mb-1.5 pl-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-light text-accent text-xs font-medium">
                {activeSkill.name}
                <button
                  onClick={clearSkill}
                  className="ml-0.5 hover:text-accent/70 transition-colors"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </span>
            </div>
          )}
          {/* Attachment preview */}
          <AttachmentPreview files={attachments} onRemove={handleRemoveAttachment} />
          {/* Model mismatch warning */}
          {isModelMismatch && (
            <div className="mb-2 px-1">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs">
                <AlertCircle size={14} className="text-warning shrink-0" strokeWidth={2} />
                <span className="text-warning">
                  此技能推荐使用 {activeSkill.recommendedModels?.join(' 或 ')} 以获得更好效果
                </span>
              </div>
            </div>
          )}
          {/* Skill palette */}
          {isPaletteOpen && (
            <SkillPalette
              skills={filteredSkills}
              selectedIndex={paletteIndex}
              onSelect={(skill) => {
                const cursorPos = textareaRef.current?.selectionStart ?? input.length
                const newInput = selectSkill(skill, input, cursorPos)
                setInput(newInput)
              }}
              onSelectTemplate={handleTemplateSelect}
              activeSkillId={activeSkill?.id}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChangeLocal}
            onKeyDown={handleKeyDown}
            placeholder={activeSkill?.placeholder ?? "输入你的需求...（输入 / 选择技能，Shift+Enter 换行）"}
            rows={1}
            disabled={isStreaming}
            className={cn(
              "w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary",
              "focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]",
              "min-h-[48px] max-h-[200px]",
              "disabled:opacity-60",
              attachments.length > 0 ? "pl-12 pr-12" : "pl-12 pr-12"
            )}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = 'auto'
              target.style.height = Math.min(target.scrollHeight, 200) + 'px'
            }}
          />
          {/* 附件按钮 */}
          <button
            onClick={handleFileSelect}
            disabled={isStreaming}
            className="absolute left-3 bottom-3 w-8 h-8 rounded-full flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
            title="添加附件"
          >
            <Paperclip size={18} strokeWidth={1.75} />
          </button>
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              className="absolute right-3 bottom-3 w-8 h-8 rounded-full flex items-center justify-center bg-error text-text-inverse cursor-pointer hover:opacity-85 transition-opacity"
            >
              <Square size={14} strokeWidth={2} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className={cn(
                "absolute right-3 bottom-3 w-8 h-8 rounded-full flex items-center justify-center transition-opacity",
                input.trim()
                  ? "bg-text-primary text-text-inverse cursor-pointer hover:opacity-85"
                  : "bg-border text-text-tertiary cursor-not-allowed"
              )}
            >
              <SendHorizonal size={16} strokeWidth={1.75} />
            </button>
          )}
          </div>
        </div>
      </div>

      {/* Template Variable Form */}
      {selectedTemplate && (
        <TemplateVariableForm
          template={selectedTemplate}
          open={templateFormOpen}
          onClose={() => {
            setTemplateFormOpen(false)
            setSelectedTemplate(null)
          }}
          onSubmit={handleTemplateSubmit}
        />
      )}
    </div>
  )
}
