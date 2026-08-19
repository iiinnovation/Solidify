import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchChatStream, compressMessages } from '@/lib/chat-api'
import { useChatStore, type ArtifactType, type Message, type MessageAttachment } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useProjectStore } from '@/stores/project-store'
import { sendNotification } from '@/lib/tauri'
import { newId } from '@/lib/id'
import { isEnabled } from '@/lib/harness/flags'
import { runQuery } from '@/lib/engine/query'
import { applyRunEvent, createRunState } from '@/lib/engine/run-state'
import { createChatQueryContext, loadChatSkillRuntime } from '@/lib/engine/chat-context'
import type { QueryEvent } from '@/lib/engine/types'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDocumentStore } from '@/stores/document-store'
import { isComposerAttachmentRecoverable, useUIStore, type ComposerAttachment } from '@/stores/ui-store'
import { attachmentMediaPath, loadAttachmentMedia, saveAttachmentMedia } from '@/lib/attachment-media'
import { useSkillStore } from '@/stores/skill-store'
import { deriveArtifactPath, materializeArtifact, normalizeArtifactPath, normalizeArtifactType } from '@/lib/workspace/materialize'
import { isTauri } from '@/lib/tauri'
import { createAttachmentResourceId, formatAttachmentManifest, type AttachmentResource } from '@/lib/attachments/types'
import { loadAttachmentResource, loadAttachmentResources, saveAttachmentResource } from '@/lib/attachments/store'

function genId() {
  return newId('msg')
}

interface ResumeRunOptions {
  conversationId: string
  assistantMessage: Message
}

/* ── 流式 Artifact 解析 ── */

interface StreamingArtifactInfo {
  title: string
  type: ArtifactType
  path: string
  content: string
}

export function processStreamingContent(fullContent: string) {
  if (!fullContent.includes('<solidify-artifact')) {
    const nakedDrawio = parseNakedDrawioArtifact(fullContent)
    if (nakedDrawio) return nakedDrawio
    return {
      cleanText: fullContent.replace(/\n{3,}/g, '\n\n').trim(),
      completeArtifacts: [],
      streamingArtifact: null,
    }
  }

  const completeRegex =
    /<solidify-artifact\b([^>]*)>([\s\S]*?)<\/solidify-artifact>/g

  const completeArtifacts: StreamingArtifactInfo[] = []
  let match
  while ((match = completeRegex.exec(fullContent)) !== null) {
    const attributes = parseArtifactAttributes(match[1])
    const type = normalizeArtifactType(attributes.type ?? 'document')
    const title = attributes.title?.trim() || '未命名交付物'
    const content = match[2].trim()
    completeArtifacts.push({
      title,
      type,
      path: normalizeArtifactPath(attributes.path, title, type, content),
      content,
    })
  }

  // 移除完整的 artifact 块
  let cleanText = fullContent.replace(completeRegex, '')

  // 检测未闭合的（正在流式传输的）artifact
  const partialRegex =
    /<solidify-artifact\b([^>]*)>([\s\S]*)$/
  const partialMatch = cleanText.match(partialRegex)

  let streamingArtifact: StreamingArtifactInfo | null = null
  if (partialMatch) {
    const attributes = parseArtifactAttributes(partialMatch[1])
    const type = normalizeArtifactType(attributes.type ?? 'document')
    const title = attributes.title?.trim() || '未命名交付物'
    streamingArtifact = {
      title,
      type,
      path: normalizeArtifactPath(attributes.path, title, type, partialMatch[2]),
      content: partialMatch[2],
    }
    cleanText = cleanText.replace(partialRegex, '')
  }

  // 清理多余空行
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim()

  return { cleanText, completeArtifacts, streamingArtifact }
}

function parseNakedDrawioArtifact(fullContent: string) {
  // Some models ignore the artifact envelope and emit the requested XML
  // directly. Only promote responses that start with mxfile, so XML examples
  // embedded in an ordinary answer remain chat text.
  const match = fullContent.match(
    /^\s*(?:```(?:xml|drawio)?[ \t]*\r?\n\s*)?(?:<\?xml\b[^>]*\?>\s*)?(<mxfile\b[\s\S]*)$/i,
  )
  if (!match) return null

  const xmlWithTail = match[1]
  const closingTag = /<\/mxfile\s*>/i.exec(xmlWithTail)
  const diagramAttributes = /<diagram\b([^>]*)>/i.exec(xmlWithTail)?.[1] ?? ''
  const title = parseArtifactAttributes(diagramAttributes).name?.trim() || 'Draw.io 图表'
  const artifact: StreamingArtifactInfo = {
    title,
    type: 'drawio',
    path: deriveArtifactPath(title, 'drawio', xmlWithTail),
    content: xmlWithTail,
  }

  if (!closingTag) {
    return { cleanText: '', completeArtifacts: [], streamingArtifact: artifact }
  }

  const xmlEnd = closingTag.index + closingTag[0].length
  const suffix = xmlWithTail.slice(xmlEnd)
  if (!/^\s*(?:```\s*)?$/.test(suffix)) return null

  artifact.content = xmlWithTail.slice(0, xmlEnd)
  artifact.path = deriveArtifactPath(title, 'drawio', artifact.content)
  return { cleanText: '', completeArtifacts: [artifact], streamingArtifact: null }
}

function parseArtifactAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeArtifactAttribute(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function decodeArtifactAttribute(value: string): string {
  const entities: Record<string, string> = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  }
  return value.replace(/&(amp|quot|apos|lt|gt);/g, (_match, name: string) => entities[name])
}

export function isDiscardableEmptyAssistant(message: Message, hasArtifact = false): boolean {
  return message.role === 'assistant'
    && message.agentRun?.status === 'aborted'
    && !message.content.trim()
    && message.agentRun.text.trim().length === 0
    && message.agentRun.tools.length === 0
    && (message.documents?.length ?? 0) === 0
    && (message.knowledgeSources?.length ?? 0) === 0
    && !hasArtifact
}

/* ── Hook ── */

export function useChat(conversationId?: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isStreamingRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const activeRequestConversationRef = useRef<string | undefined>(conversationId)
  const streamConversationRef = useRef<string | undefined>(conversationId)
  const messagesOwnerRef = useRef<string | undefined>(conversationId)
  const resumedConversationsRef = useRef(new Set<string>())
  const navigate = useNavigate()

  const addArtifact = useChatStore((s) => s.addArtifact)
  const updateArtifactContent = useChatStore((s) => s.updateArtifactContent)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessageToConversation = useChatStore((s) => s.addMessageToConversation)
  const patchMessageInConversation = useChatStore((s) => s.patchMessageInConversation)
  const removeMessageFromConversation = useChatStore((s) => s.removeMessageFromConversation)
  const removeLastMessageFromConversation = useChatStore((s) => s.removeLastMessageFromConversation)
  const truncateMessagesFrom = useChatStore((s) => s.truncateMessagesFrom)
  const artifacts = useChatStore((s) => s.artifacts)
  const getActiveProvider = useModelStore((s) => s.getActiveProvider)


  // 从 store 加载已有对话
  useEffect(() => {
    // A route change must detach the old stream before loading the new view.
    // The provider may resolve one more chunk after abort, so the sequence
    // token below also prevents stale callbacks from painting into this chat.
    const activeConversation = activeRequestConversationRef.current
    if (activeConversation !== undefined && activeConversation !== conversationId) {
      const store = useChatStore.getState()
      const oldConversation = store.conversations.find((item) => item.id === activeConversation)
      const runningAssistant = [...(oldConversation?.messages ?? [])].reverse()
        .find((message) => message.role === 'assistant' && message.agentRun?.status === 'running')
      if (runningAssistant?.agentRun) {
        const stoppedEvent: QueryEvent = {
          type: 'run.failed',
          error: { kind: 'aborted', message: '已切换到其他对话' },
        }
        store.patchMessageInConversation(activeConversation, runningAssistant.id, {
          agentRun: applyRunEvent(runningAssistant.agentRun, stoppedEvent),
          runEvents: [...(runningAssistant.runEvents ?? []), stoppedEvent],
        })
      }
      requestSequenceRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      activeRequestConversationRef.current = undefined
      isStreamingRef.current = false
      setIsStreaming(false)
    }
    messagesOwnerRef.current = conversationId
    if (conversationId) {
      const store = useChatStore.getState()
      const conv = store.conversations.find((c) => c.id === conversationId)
      if (conv) {
        const cleanedMessages = conv.messages.filter((message) => !isDiscardableEmptyAssistant(
          message,
          store.artifacts.some((artifact) => artifact.messageId === message.id),
        ))
        setMessages(cleanedMessages)
        if (cleanedMessages.length !== conv.messages.length) {
          for (const message of conv.messages) {
            if (!cleanedMessages.includes(message)) store.removeMessageFromConversation(conversationId, message.id)
          }
        }
      } else {
        setMessages([])
      }
    } else {
      setMessages([])
    }
    setError(null)
  }, [conversationId])

  // 组件卸载时中止正在进行的流，防止资源泄漏
  useEffect(() => {
    return () => {
      requestSequenceRef.current += 1
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      activeRequestConversationRef.current = undefined
      isStreamingRef.current = false
    }
  }, [])

  // 跟踪当前 conversationId（sendMessage 闭包中需要最新值）
  const convIdRef = useRef(conversationId)
  convIdRef.current = conversationId

  const sendMessage = useCallback(
    async (
      content: string,
      composerAttachments?: ComposerAttachment[],
      skillSystemPrompt?: string,
      skillSkipConfirmation?: boolean,
      resume?: ResumeRunOptions,
      historyOverride?: Message[],
      skillId?: string,
      skillName?: string,
    ) => {
      if ((!content.trim() && !resume) || isStreamingRef.current) return
      const unrecoverableAttachment = composerAttachments?.find((att) => !isComposerAttachmentRecoverable(att))
      if (unrecoverableAttachment) {
        setError(new Error(`附件「${unrecoverableAttachment.name}」已无法恢复，请重新选择文件`))
        return
      }
      const requestStartedAt = Date.now()
      // React state updates are asynchronous. Use a synchronous guard so two
      // events in the same render cannot start duplicate model runs.
      isStreamingRef.current = true
      const requestToken = ++requestSequenceRef.current
      const isCurrentRequest = () => requestSequenceRef.current === requestToken

      setError(null)

      const savedProviderId = resume?.assistantMessage.agentContext?.providerId
      const activeProvider = savedProviderId
        ? useModelStore.getState().providers.find((provider) => provider.id === savedProviderId) ?? null
        : getActiveProvider()
      if (!activeProvider) {
        const providerError = new Error(savedProviderId
          ? '无法恢复 Agent：原 Provider 已被删除'
          : '请先在设置中配置 AI 模型')
        if (isCurrentRequest()) setError(providerError)
        if (resume?.assistantMessage.agentRun) {
          const failureEvent: QueryEvent = {
            type: 'run.failed',
            error: { kind: 'internal', message: providerError.message },
          }
          const failedRun = applyRunEvent(resume.assistantMessage.agentRun, failureEvent)
          const runEvents = [...(resume.assistantMessage.runEvents ?? []), failureEvent]
          if (isCurrentRequest()) {
            setMessages((prev) => prev.map((message) =>
              message.id === resume.assistantMessage.id
                ? { ...message, agentRun: failedRun, runEvents }
                : message,
            ))
            patchMessageInConversation(
              resume.conversationId,
              resume.assistantMessage.id,
              { agentRun: failedRun, runEvents },
            )
          }
        }
        if (isCurrentRequest()) {
          isStreamingRef.current = false
          activeRequestConversationRef.current = undefined
        }
        return
      }

      // 确定对话 ID —— 没有则新建
      let currentConvId = resume?.conversationId ?? convIdRef.current
      if (!currentConvId) {
        const title = content.slice(0, 20) + (content.length > 20 ? '…' : '')
        currentConvId = createConversation(title)
        convIdRef.current = currentConvId
        navigate(`/chat/${currentConvId}`, { replace: true })
      }
      activeRequestConversationRef.current = currentConvId
      streamConversationRef.current = currentConvId

      const skillObj = skillId
        ? { id: skillId, name: skillName || useSkillStore.getState().getAllSkills().find((s) => s.id === skillId)?.name || skillId }
        : (skillSystemPrompt ? { id: 'custom', name: '自定义技能' } : undefined)

      const userMessageId = genId()
      // Full attachment text stays in the local resource plane. The model only
      // receives a bounded manifest and reads content through attachment tools.
      const userMsg: Message = {
        id: userMessageId,
        role: 'user',
        content,
        skill: skillObj,
        requestContext: {
          skillSystemPrompt,
          skillSkipConfirmation,
          skillId,
        },
        attachments: composerAttachments?.map((a) => ({
          attachmentId: a.attachmentId,
          name: a.name,
          size: a.size,
          mimeType: a.mimeType ?? a.file?.type,
          extractedText: a.extractedText,
          mediaUrl: a.mediaUrl,
          mediaId: a.mediaId,
          recoverable: a.recoverable,
        }))
      }
      const assistantMsg: Message = resume?.assistantMessage
        ?? { id: genId(), role: 'assistant', content: '' }
      setIsStreaming(true)
      const abortController = new AbortController()
      abortRef.current = abortController

      const savedAgentContext = resume?.assistantMessage.agentContext
      const preloadWorkspaceRoot = savedAgentContext
        ? savedAgentContext.workspaceRoot
        : useWorkspaceStore.getState().workspaceRoot
      const preloadSkillId = savedAgentContext ? savedAgentContext.skillId : skillId
      const skillRuntimePromise = isEnabled('agentLoop') && isEnabled('skillV2')
        ? loadChatSkillRuntime({
            workspaceRoot: preloadWorkspaceRoot,
            skillName: preloadSkillId,
          }).catch((error) => {
            // The legacy inline prompt remains usable if a local Skill root is
            // temporarily unavailable; surface the failure for diagnosis.
            console.warn('[skills] Failed to load Skill registry:', error)
            return undefined
          })
        : Promise.resolve(undefined)

      // Attachment extraction, knowledge retrieval and Skill discovery do not
      // depend on one another. Start them together so the first model request
      // waits for the slowest preparation step instead of their sum.
      const attachmentPromise = (async () => {
        if (!composerAttachments?.length) return { attachmentResources: [], pptdMedia: undefined, error: undefined }
        try {
          const { extractText } = await import('@/lib/file-extractor')

          // 分离新文件（需要提取）和已有提取内容（撤回恢复的附件）
          const extractedTexts: string[] = []
          const newFiles: { index: number; file: File }[] = []

          for (let i = 0; i < composerAttachments.length; i++) {
            const att = composerAttachments[i]
            if (att.extractedText !== undefined) {
              // 撤回恢复的附件：直接复用已提取的文本
              extractedTexts.push(att.extractedText)
            } else {
              const file = getAttachmentFile(att)
              if (file) {
                // 新添加的文件：需要提取
                newFiles.push({ index: i, file })
                extractedTexts.push('__PENDING__')
              } else {
                const stored = att.attachmentId ? await loadAttachmentResource(att.attachmentId) : undefined
                if (stored?.text !== undefined) {
                  extractedTexts.push(stored.text)
                  if (!att.mediaUrl && stored.mediaUrl) att.mediaUrl = stored.mediaUrl
                  if (!att.mediaId && stored.mediaId) att.mediaId = stored.mediaId
                } else {
                  throw new Error(`附件资源不存在或已损坏：${att.name}`)
                }
              }
            }
          }

          // 批量提取新文件的文本
          if (newFiles.length > 0) {
            const newTexts = await Promise.all(newFiles.map(({ file }) => extractText(file)))
            newFiles.forEach(({ index }, i) => {
              extractedTexts[index] = newTexts[i]
            })
          }

          // 收集图片媒体 (支持原生 File 和已有的 mediaUrl)
          const { attachmentMedia, mediaUrls, mediaIds } = await collectPptdAttachmentMedia(composerAttachments)

          // 回填提取文本和轻量媒体引用；Data URL 只保留在当前运行时。
          if (userMsg.attachments) {
            for (let i = 0; i < userMsg.attachments.length; i++) {
              if (!userMsg.attachments[i].extractedText) {
                userMsg.attachments[i].extractedText = extractedTexts[i]
              }
              if (mediaUrls[i] && !userMsg.attachments[i].mediaUrl) {
                userMsg.attachments[i].mediaUrl = mediaUrls[i]
              }
              if (mediaIds[i]) userMsg.attachments[i].mediaId = mediaIds[i]
              userMsg.attachments[i].recoverable = !isImageAttachment(composerAttachments[i]) || Boolean(mediaUrls[i])
            }
          }

          const attachmentResources: AttachmentResource[] = (userMsg.attachments ?? []).map((attachment, index) => {
            const resource: AttachmentResource = {
              id: attachment.attachmentId ?? createAttachmentResourceId({
                name: attachment.name,
                size: attachment.size,
                mimeType: attachment.mimeType,
                text: extractedTexts[index],
                mediaId: mediaIds[index] ?? attachment.mediaId,
              }),
              name: attachment.name,
              size: attachment.size,
              mimeType: attachment.mimeType,
              text: extractedTexts[index],
              mediaUrl: mediaUrls[index] ?? attachment.mediaUrl,
              mediaId: mediaIds[index] ?? attachment.mediaId,
            }
            attachment.attachmentId = resource.id
            return resource
          })
          await Promise.all(attachmentResources.map(saveAttachmentResource))
          return {
            attachmentResources,
            pptdMedia: Object.keys(attachmentMedia).length > 0 ? attachmentMedia : undefined,
            error: undefined,
          }
        } catch (error) {
          console.error('文件内容提取失败:', error)
          return {
            attachmentResources: [],
            pptdMedia: undefined,
            error: error instanceof Error ? error : new Error('附件内容提取失败'),
          }
        }
      })()

      // 知识库增强：搜索相关知识
      const knowledgeEnabled = useKnowledgeEnhancementStore.getState().enabled
      const matchCount = useKnowledgeEnhancementStore.getState().matchCount
      const matchThreshold = useKnowledgeEnhancementStore.getState().matchThreshold
      const activeProjectId = useProjectStore.getState().activeProjectId
      const addRecentSource = useKnowledgeEnhancementStore.getState().addRecentSource

      // 检查是否启用知识库功能（环境变量控制）
      const enableKnowledge = import.meta.env.VITE_ENABLE_KNOWLEDGE !== 'false'

      const knowledgePromise = (async (): Promise<{
        context: string
        sources: Array<{ id: string; title: string; similarity: number }>
      }> => {
        if (resume || !knowledgeEnabled || !enableKnowledge) return { context: '', sources: [] }
        try {
          const { getRAGProvider } = await import('@/lib/rag')
          const ragProvider = getRAGProvider()

          const knowledgeResults = await ragProvider.searchKnowledge(content, {
            projectId: activeProjectId || undefined,
            matchCount,
            matchThreshold,
          })

          if (knowledgeResults.length > 0) {
            // 记录引用的知识来源
            knowledgeResults.forEach(result => {
              addRecentSource({
                id: result.id,
                title: result.title,
                content: result.content.slice(0, 200), // 只保留前 200 字
                similarity: result.similarity,
              })
            })

            // 保存知识来源用于显示
            const sources = knowledgeResults.map(result => ({
              id: result.id,
              title: result.title,
              similarity: result.similarity,
            }))

            // 构建知识上下文
            return {
              sources,
              context: `

## 相关知识库内容

${knowledgeResults.map((result, index) => `
### [${index + 1}] ${result.title}
${result.content}
`).join('\n')}

---

请基于以上知识库内容回答用户问题。如果知识库内容与问题相关，请引用相关内容。
`,
            }
          }
        } catch (error) {
          console.error('知识库搜索失败:', error)
          // 搜索失败不影响正常对话
        }
        return { context: '', sources: [] }
      })()

      const [attachmentResult, knowledgeResult, preloadedSkillRuntime] = await Promise.all([
        attachmentPromise,
        knowledgePromise,
        skillRuntimePromise,
      ])
      if (attachmentResult.error) {
        if (isCurrentRequest()) {
          setError(attachmentResult.error)
          isStreamingRef.current = false
          setIsStreaming(false)
          abortRef.current = null
          activeRequestConversationRef.current = undefined
        }
        return
      }
      const historicalAttachmentIds = messages.flatMap((message) =>
        message.attachments?.map((attachment) => attachment.attachmentId).filter((id): id is string => Boolean(id)) ?? [],
      )
      const historicalResources = await loadAttachmentResources(historicalAttachmentIds)
      const attachmentResources = [...new Map(
        [...historicalResources, ...attachmentResult.attachmentResources].map((resource) => [resource.id, resource]),
      ).values()]
      const pptdMedia = await rebuildPptdAttachmentMedia(attachmentResources, attachmentResult.pptdMedia)
      const knowledgeSources = knowledgeResult.sources
      const canReadAttachments = isEnabled('agentLoop') && activeProvider.supportsTools !== false
      const attachmentContext = attachmentResources.length > 0
        ? `\n\n${formatAttachmentManifest(attachmentResources)}\n\n${canReadAttachments
          ? '附件正文不会自动展开；需要时请使用 search_attachments 和 read_attachment 按需读取。'
          : '当前为兼容聊天模式，只提供附件的有限预览；如需分段读取，请启用 Agent 模式。'}`
        : ''
      let enrichedContent = `${content}${attachmentContext}`

      // 将知识上下文添加到用户消息中
      if (knowledgeResult.context) {
        enrichedContent = `${enrichedContent}${knowledgeResult.context}`
      }

      if (!isCurrentRequest()) return
      if (abortController.signal.aborted) {
        isStreamingRef.current = false
        setIsStreaming(false)
        abortRef.current = null
        activeRequestConversationRef.current = undefined
        return
      }

      // 更新本地 state + store
      if (!resume) {
        setMessages((prev) => [...prev, userMsg, assistantMsg])
        addMessageToConversation(currentConvId, userMsg)
        addMessageToConversation(currentConvId, assistantMsg)
      }

      // 流式 artifact 跟踪
      let streamingArtifactId: string | null = null
      let streamingDocumentPath: string | null = null
      let streamingDocumentModifiedAt: number | undefined
      const pendingMaterializations: Promise<void>[] = []
      const documentRefs: Array<{ path: string; messageId: string; version: number }> = []
      const materializeRunId = assistantMsg.agentRun?.runId ?? newId('run')
      const workspaceRoot = useWorkspaceStore.getState().workspaceRoot
      const useFileDocuments = isEnabled('workbenchV2') && isEnabled('localWorkspace') && isTauri && Boolean(workspaceRoot)
      let observedAssistantOutput = false
      let completedArtifactCount = resume
        ? processStreamingContent(assistantMsg.agentRun?.text ?? '').completeArtifacts.length
        : 0

      const discardAssistantPlaceholder = () => {
        if (resume || observedAssistantOutput) return false
        const store = useChatStore.getState()
        const persisted = store.conversations
          .find((conversation) => conversation.id === currentConvId)
          ?.messages.find((message) => message.id === assistantMsg.id)
        const hasPersistedOutput = Boolean(
          persisted?.content.trim()
          || persisted?.documents?.length
          || persisted?.knowledgeSources?.length
          || store.artifacts.some((artifact) => artifact.messageId === assistantMsg.id),
        )
        if (hasPersistedOutput) return false
        setMessages((previous) => previous.filter((message) => message.id !== assistantMsg.id))
        removeMessageFromConversation(currentConvId, assistantMsg.id)
        return true
      }

      /**
       * `persist: false` updates only the local view. The conversation store is
       * `persist()`-backed, so every write there re-serializes the whole
       * conversation tree into localStorage — doing that once per streamed token
       * is both O(n²) and a fast route to the storage quota.
       */
      const patchAssistantMessage = (patch: Partial<Message>, persist = true) => {
        if (!isCurrentRequest()) return
        setMessages((prev) => prev.map((message) =>
          message.id === assistantMsg.id ? { ...message, ...patch } : message,
        ))
        if (persist) patchMessageInConversation(currentConvId, assistantMsg.id, patch)
      }

      const consumeArtifactContent = (fullContent: string, final = false, persist = true) => {
        if (!isCurrentRequest()) return ''
        if (fullContent.trim()) observedAssistantOutput = true
        const { cleanText, completeArtifacts, streamingArtifact } =
          processStreamingContent(fullContent)

        while (completedArtifactCount < completeArtifacts.length) {
          const artifact = completeArtifacts[completedArtifactCount]
          if (useFileDocuments && workspaceRoot) {
            const finalPath = artifact.path
            if (streamingDocumentPath && streamingDocumentPath !== finalPath) {
              useDocumentStore.getState().removeDocument(streamingDocumentPath)
            }
            const finalModifiedAt = streamingDocumentPath === finalPath
              ? streamingDocumentModifiedAt
              : useWorkspaceStore.getState().entries
                .find((entry) => entry.kind === 'file' && entry.path === finalPath)?.modifiedAt
            const completed = { ...artifact, path: finalPath }
            useDocumentStore.getState().upsertDocument({
              ...completed, messageId: assistantMsg.id, streaming: false, version: 1,
              modifiedAt: finalModifiedAt,
            })
            const task = materializeArtifact(completed, {
              workspaceRoot,
              runId: materializeRunId,
              messageId: assistantMsg.id,
              expectedModifiedAt: finalModifiedAt,
            }).then(() => {
              const saved = useDocumentStore.getState().documents[finalPath]
              documentRefs.push({ path: finalPath, messageId: assistantMsg.id, version: saved?.version ?? 1 })
            }).catch((reason) => {
              useDocumentStore.getState().patchDocument(finalPath, {
                streaming: false,
                error: reason instanceof Error ? reason.message : String(reason),
              })
            })
            pendingMaterializations.push(task)
            streamingDocumentPath = null
            streamingDocumentModifiedAt = undefined
          } else if (streamingArtifactId) {
            updateArtifactContent(streamingArtifactId, artifact.content, false)
            streamingArtifactId = null
          } else {
            addArtifact({
              id: newId('artifact'),
              title: artifact.title,
              type: artifact.type,
              content: artifact.content,
              messageId: assistantMsg.id,
              version: 1,
            })
          }
          completedArtifactCount++
        }

        if (streamingArtifact) {
          if (useFileDocuments) {
            if (!streamingDocumentPath) {
              streamingDocumentPath = streamingArtifact.path || deriveArtifactPath(streamingArtifact.title, streamingArtifact.type, streamingArtifact.content)
              streamingDocumentModifiedAt = useWorkspaceStore.getState().entries
                .find((entry) => entry.kind === 'file' && entry.path === streamingDocumentPath)?.modifiedAt
              useDocumentStore.getState().upsertDocument({
                ...streamingArtifact,
                path: streamingDocumentPath,
                messageId: assistantMsg.id,
                streaming: true,
                version: 1,
                modifiedAt: streamingDocumentModifiedAt,
              })
            } else {
              useDocumentStore.getState().patchDocument(streamingDocumentPath, {
                content: streamingArtifact.content, streaming: true,
              })
            }
          } else if (!streamingArtifactId) {
            streamingArtifactId = newId('artifact')
            addArtifact({
              id: streamingArtifactId,
              title: streamingArtifact.title,
              type: streamingArtifact.type,
              content: streamingArtifact.content,
              messageId: assistantMsg.id,
              version: 1,
              streaming: true,
            })
          } else {
            updateArtifactContent(streamingArtifactId, streamingArtifact.content, true)
          }
        }

        if (final && streamingArtifactId) {
          const currentContent = useChatStore.getState().artifacts
            .find((artifact) => artifact.id === streamingArtifactId)?.content ?? ''
          updateArtifactContent(streamingArtifactId, currentContent, false)
          streamingArtifactId = null
        }

        // A run can end without the closing tag ever arriving — the output
        // ceiling was hit, the user stopped it, the request failed. The
        // document still has to settle: while it stays flagged as streaming
        // every renderer keeps showing raw text instead of the parsed
        // deck/diagram, so a truncated answer looks like a plain document.
        if (final && streamingDocumentPath) {
          useDocumentStore.getState().patchDocument(streamingDocumentPath, { streaming: false })
          streamingDocumentPath = null
          streamingDocumentModifiedAt = undefined
        }

        patchAssistantMessage({
          content: cleanText,
          ...(final && knowledgeSources.length > 0 ? { knowledgeSources } : {}),
        }, persist)
        return cleanText
      }

      const flushMaterializations = async () => {
        await Promise.all(pendingMaterializations)
        if (isCurrentRequest() && documentRefs.length > 0) patchAssistantMessage({ documents: [...documentRefs] })
      }

      try {
        const persistedResumeMessages = resume
          ? useChatStore.getState().conversations
            .find((conversation) => conversation.id === resume.conversationId)
            ?.messages
          : undefined
        const resumeMessages = persistedResumeMessages ?? messages
        const resumedAssistantIndex = resume
          ? resumeMessages.findIndex((message) => message.id === resume.assistantMessage.id)
          : -1
        const unfilteredBaseMessages = resume
          ? resumedAssistantIndex >= 0
            ? resumeMessages.slice(0, resumedAssistantIndex)
            : resumeMessages.filter((message) => message.id !== resume.assistantMessage.id)
          : historyOverride ?? messages
        const currentArtifacts = useChatStore.getState().artifacts
        const baseMessages = unfilteredBaseMessages.filter((message) => !isDiscardableEmptyAssistant(
          message,
          currentArtifacts.some((artifact) => artifact.messageId === message.id),
        ))
        const allMessages = (resume ? baseMessages : [...baseMessages, userMsg]).map((m) => ({
          role: m.role,
          content: m.content,
        }))

        // 应用上下文压缩：保留首轮 + 最近 10 轮
        const apiMessages = compressMessages(allMessages, 10)

        // The stored user message remains the user's original text. Resource
        // manifests are reconstructed per run so stale attachment previews do
        // not become permanent conversation history.
        const messagesWithFiles = [...apiMessages]
        if (resume && attachmentContext && messagesWithFiles.length > 0) {
          const last = messagesWithFiles[messagesWithFiles.length - 1]
          messagesWithFiles[messagesWithFiles.length - 1] = { ...last, content: `${last.content}${attachmentContext}` }
        } else if (enrichedContent !== content) {
          messagesWithFiles[messagesWithFiles.length - 1] = {
            role: 'user',
            content: enrichedContent
          }
        }

        if (isEnabled('agentLoop')) {
          const runId = assistantMsg.agentRun?.runId ?? newId('run')
          let run = assistantMsg.agentRun
            ? {
                ...assistantMsg.agentRun,
                status: 'running' as const,
                text: resume ? '' : assistantMsg.agentRun.text,
                completedAt: undefined,
                error: undefined,
              }
            : createRunState(runId)
          const runEvents: QueryEvent[] = [...(assistantMsg.runEvents ?? [])]
          const agentContext = resume?.assistantMessage.agentContext ?? {
            providerId: activeProvider.id,
            workspaceRoot: useWorkspaceStore.getState().workspaceRoot ?? undefined,
            skillSystemPrompt,
            skillSkipConfirmation,
            skillId,
          }
          patchAssistantMessage({ agentRun: run, runEvents, agentContext })

          const selectedSkillId = agentContext.skillId ?? skillId
          const skillRuntime = isEnabled('skillV2')
            && selectedSkillId === preloadSkillId
            && agentContext.workspaceRoot === (preloadWorkspaceRoot ?? undefined)
            ? preloadedSkillRuntime
            : await loadChatSkillRuntime({
                workspaceRoot: agentContext.workspaceRoot,
                skillName: selectedSkillId,
              }).catch((error) => {
                console.warn('[skills] Failed to load Skill registry:', error)
                return undefined
              })

          if (!isCurrentRequest()) return

          const context = createChatQueryContext({
            runId,
            requestStartedAt,
            conversationId: currentConvId,
            messages: messagesWithFiles,
            provider: activeProvider,
            signal: abortController.signal,
            skillSystemPrompt: agentContext.skillSystemPrompt,
            skillSkipConfirmation: agentContext.skillSkipConfirmation,
            loadedSkill: skillRuntime?.skill,
            skillResources: skillRuntime?.resources,
            skillRegistry: skillRuntime?.registry,
            pptdMedia,
            attachments: attachmentResources,
            workspaceRoot: agentContext.workspaceRoot,
            restoreSnapshot: Boolean(resume),
          })

          const STREAM_FRAME_MS = 60
          let latestText: string | undefined
          let frameDirty = false
          let frameTimer: ReturnType<typeof setTimeout> | undefined

          const flushStreamFrame = () => {
            if (frameTimer !== undefined) {
              clearTimeout(frameTimer)
              frameTimer = undefined
            }
            if (!frameDirty) return
            frameDirty = false
            latestText = consumeArtifactContent(run.text, false, false)
            patchAssistantMessage({ content: latestText, agentRun: run }, false)
          }

          try {
            for await (const event of runQuery(context)) {
              if (!isCurrentRequest()) break
              if (event.type === 'message.delta') {
                run = applyRunEvent(run, event)
                frameDirty = true
                if (frameTimer === undefined) {
                  frameTimer = setTimeout(flushStreamFrame, STREAM_FRAME_MS)
                }
                continue
              }

              flushStreamFrame()

              // Deltas and progress ticks are transient UI signal, not run facts:
              // the text is already accumulated into `run.text` by applyRunEvent.
              // Persisting them grew runEvents without bound and made every patch
              // copy an ever-larger array into localStorage.
              const isDurableFact = event.type !== 'tool.progress'
              if (isDurableFact) runEvents.push(event)
              const pptdPreview = getPptdProgressPreview(event)
              const reducedEvent = pptdPreview && event.type === 'tool.progress'
                ? withoutPptdPreview(event)
                : event
              run = applyRunEvent(run, reducedEvent)
              if (pptdPreview) {
                observedAssistantOutput = true
                if (useFileDocuments) {
                  const previewPath = normalizeArtifactPath(
                    pptdPreview.path,
                    pptdPreview.title,
                    'slides',
                    pptdPreview.content,
                  )
                  if (streamingDocumentPath && streamingDocumentPath !== previewPath) {
                    useDocumentStore.getState().removeDocument(streamingDocumentPath)
                  }
                  if (streamingDocumentPath !== previewPath) {
                    streamingDocumentPath = previewPath
                    streamingDocumentModifiedAt = useWorkspaceStore.getState().entries
                      .find((entry) => entry.kind === 'file' && entry.path === previewPath)?.modifiedAt
                    useDocumentStore.getState().upsertDocument({
                      path: previewPath,
                      title: pptdPreview.title,
                      type: 'slides',
                      content: pptdPreview.content,
                      messageId: assistantMsg.id,
                      streaming: true,
                      version: 1,
                      modifiedAt: streamingDocumentModifiedAt,
                    })
                  } else {
                    useDocumentStore.getState().patchDocument(previewPath, {
                      title: pptdPreview.title,
                      content: pptdPreview.content,
                      streaming: true,
                    })
                  }
                } else if (!streamingArtifactId) {
                  streamingArtifactId = newId('artifact')
                  addArtifact({
                    id: streamingArtifactId,
                    title: pptdPreview.title,
                    type: 'slides',
                    content: pptdPreview.content,
                    messageId: assistantMsg.id,
                    version: 1,
                    streaming: true,
                  })
                } else {
                  updateArtifactContent(streamingArtifactId, pptdPreview.content, true)
                }
              }
              const completedTool = event.type === 'tool.completed'
                ? [...runEvents].reverse().find((candidate) =>
                    candidate.type === 'tool.requested' && candidate.call.id === event.callId)
                : undefined
              if (
                useFileDocuments
                && event.type === 'tool.completed'
                && event.result.success
                && completedTool?.type === 'tool.requested'
                && ['write_file', 'materialize_document'].includes(completedTool.call.name)
              ) {
                const data = event.result.data as { path?: unknown } | undefined
                if (typeof data?.path === 'string') {
                  useWorkspaceStore.getState().selectPath(data.path)
                  useDocumentStore.getState().setActivePath(data.path)
                  void useWorkspaceStore.getState().refreshTree()
                }
              }
              if (event.type === 'message.completed') {
                latestText = consumeArtifactContent(run.text, false, false)
              }
              // Durable facts (including run.completed / run.failed on abort) carry
              // the latest text through to the stored conversation, so nothing is
              // lost by skipping the per-token writes.
              patchAssistantMessage({
                ...(latestText !== undefined ? { content: latestText } : {}),
                agentRun: run,
                ...(isDurableFact ? { runEvents: [...runEvents] } : {}),
              }, isDurableFact)
            }
          } finally {
            if (frameTimer !== undefined) {
              clearTimeout(frameTimer)
              frameTimer = undefined
            }
            frameDirty = false
          }

          const finalText = consumeArtifactContent(run.text, true)
          if (!isCurrentRequest()) return
          await flushMaterializations()
          const finalPatch: Partial<Message> = {
            ...(finalText !== undefined ? { content: finalText } : {}),
            agentRun: run,
            metrics: run.metrics,
            runEvents: [...runEvents],
          }
          const settledAssistant = { ...assistantMsg, ...finalPatch }
          const hasArtifact = useChatStore.getState().artifacts.some((artifact) => artifact.messageId === assistantMsg.id)
          if (isDiscardableEmptyAssistant(settledAssistant, hasArtifact)) {
            discardAssistantPlaceholder()
            return
          }
          patchAssistantMessage(finalPatch)
          return
        }

        const requestStartTime = Date.now()
        let firstTokenTime: number | undefined

        const response = await fetchChatStream({
          messages: messagesWithFiles,
          provider: {
            apiUrl: activeProvider.apiUrl,
            apiKey: activeProvider.apiKey,
            modelId: activeProvider.modelId,
            format: activeProvider.format,
          },
          skillSystemPrompt,
          skillSkipConfirmation,
        })

        if (!response.ok) {
          const errData = await response.json().catch(() => null)
          throw new Error(
            errData?.error?.message ?? errData?.message ?? `请求失败: ${response.status}`,
          )
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('无法读取响应流')

        const decoder = new TextDecoder()
        let fullContent = ''
        let buffer = ''

        while (true) {
          if (abortController.signal.aborted) break

          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              // OpenAI 格式: choices[0].delta.content
              // Anthropic 格式: type=content_block_delta, delta.type=text_delta, delta.text
              const delta =
                parsed.choices?.[0]?.delta?.content
                ?? (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta'
                  ? parsed.delta.text
                  : undefined)
              if (delta) {
                if (!firstTokenTime) firstTokenTime = Date.now()
                fullContent += delta
                consumeArtifactContent(fullContent, false, false)
              }
            } catch {
              // 非 JSON 行，跳过
            }
          }
        }

        reader.releaseLock()

        const requestEndTime = Date.now()
        const durationMs = Math.max(0, requestEndTime - requestStartTime)
        const ttftMs = firstTokenTime ? Math.max(0, firstTokenTime - requestStartTime) : undefined
        const outputTokens = Math.ceil(fullContent.length * 0.75)
        const genDurationSec = (firstTokenTime ? (requestEndTime - firstTokenTime) : durationMs) / 1000
        const tokensPerSecond = genDurationSec > 0 && outputTokens > 0
          ? Number((outputTokens / genDurationSec).toFixed(1))
          : undefined
        const metrics = {
          durationMs,
          ttftMs,
          tokensPerSecond,
          outputTokens,
        }

        consumeArtifactContent(fullContent, true)
        patchAssistantMessage({ metrics }, true)
        await flushMaterializations()
        if (abortController.signal.aborted) discardAssistantPlaceholder()
      } catch (err) {
        if (abortController.signal.aborted || !isCurrentRequest()) {
          if (isCurrentRequest()) discardAssistantPlaceholder()
          return
        }
        const error = err instanceof Error ? err : new Error('未知错误')
        setError(error)
        // New requests discard an empty placeholder. A resumed run retains
        // its persisted assistant message so the user can retry recovery.
        if (resume) return
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && !last.content) {
            return prev.slice(0, -1)
          }
          return prev
        })
        if (currentConvId) {
          const conv = useChatStore.getState().conversations.find((c) => c.id === currentConvId)
          const lastMsg = conv?.messages[conv.messages.length - 1]
          if (lastMsg?.role === 'assistant' && !lastMsg.content) {
            removeLastMessageFromConversation(currentConvId)
          }
        }
      } finally {
        if (isCurrentRequest()) {
          isStreamingRef.current = false
          setIsStreaming(false)
          abortRef.current = null
          activeRequestConversationRef.current = undefined
        }
        // 窗口不在前台时发送系统通知
        if (document.hidden) {
          sendNotification('Solidify', 'AI 回复已生成')
        }
      }
    },
    [messages, addArtifact, updateArtifactContent, createConversation, addMessageToConversation, patchMessageInConversation, removeMessageFromConversation, removeLastMessageFromConversation, navigate, getActiveProvider],
  )

  useEffect(() => {
    if (
      !conversationId
      || isStreaming
      || !isEnabled('agentLoop')
      || resumedConversationsRef.current.has(conversationId)
    ) return

    const conversation = useChatStore.getState().conversations
      .find((item) => item.id === conversationId)
    const assistantMessage = [...(conversation?.messages ?? [])].reverse()
      .find((message) => message.role === 'assistant' && message.agentRun?.status === 'running')
    if (!assistantMessage) return

    resumedConversationsRef.current.add(conversationId)
    void sendMessage(
      '',
      undefined,
      assistantMessage.agentContext?.skillSystemPrompt,
      assistantMessage.agentContext?.skillSkipConfirmation,
      { conversationId, assistantMessage },
    )
  }, [conversationId, isStreaming, sendMessage])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
    if (!isEnabled('agentLoop')) setIsStreaming(false)
  }, [])

  const recallMessage = useCallback((messageId?: string) => {
    const currentConvId = convIdRef.current
    if (!currentConvId) return null

    const store = useChatStore.getState()
    const conv = store.conversations.find((c) => c.id === currentConvId)
    if (!conv || conv.messages.length === 0) return null

    let targetUserIndex = -1
    if (messageId) {
      targetUserIndex = conv.messages.findIndex((m) => m.id === messageId && m.role === 'user')
    } else {
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === 'user') {
          targetUserIndex = i
          break
        }
      }
    }

    if (targetUserIndex === -1) return null
    const targetUserMsg = conv.messages[targetUserIndex]

    // 先使旧请求失效，再停止流式输出，避免 abort 后到达的 chunk 写回撤回内容。
    requestSequenceRef.current += 1
    if (isStreamingRef.current) {
      abortRef.current?.abort()
      abortRef.current = null
      isStreamingRef.current = false
      setIsStreaming(false)
    }
    activeRequestConversationRef.current = undefined
    streamConversationRef.current = undefined

    const removedMessages = conv.messages.slice(targetUserIndex)
    const removedMessageIds = new Set(removedMessages.map((message) => message.id))
    const remainingDocumentPaths = new Set(
      store.conversations.flatMap((conversation) => conversation.id === currentConvId
        ? conversation.messages.slice(0, targetUserIndex)
        : conversation.messages
      ).flatMap((message) => message.documents?.map((document) => document.path) ?? []),
    )
    const documentStore = useDocumentStore.getState()
    const removedDocumentPaths = new Set([
      ...removedMessages.flatMap((message) => message.documents?.map((document) => document.path) ?? []),
      ...Object.values(documentStore.documents)
        .filter((document) => document.messageId && removedMessageIds.has(document.messageId))
        .map((document) => document.path),
    ])
    for (const path of removedDocumentPaths) {
      if (!remainingDocumentPaths.has(path)) useDocumentStore.getState().removeDocument(path)
    }

    // 截断该消息及之后的所有消息
    truncateMessagesFrom(currentConvId, targetUserMsg.id)
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === targetUserMsg.id)
      return idx === -1 ? prev : prev.slice(0, idx)
    })

    // 回填到 UI store 的草稿中
    const { setComposerDraft } = useUIStore.getState()
    let draftSkill = null
    if (targetUserMsg.skill) {
      const allSkills = useSkillStore.getState().getAllSkills()
      draftSkill = allSkills.find((s) => s.id === targetUserMsg.skill?.id) ?? {
        id: targetUserMsg.skill.id,
        name: targetUserMsg.skill.name,
        description: '',
        icon: 'Sparkles',
        placeholder: '',
        skipConfirmation: targetUserMsg.requestContext?.skillSkipConfirmation ?? true,
        systemPrompt: targetUserMsg.requestContext?.skillSystemPrompt ?? '',
      }
    }

    const restoredAttachments = messageAttachmentsToComposer(targetUserMsg.attachments)
    setComposerDraft(currentConvId, {
      input: targetUserMsg.content,
      attachments: restoredAttachments,
      skill: draftSkill,
    })
    // Hydrate resources that were intentionally omitted from persisted message
    // JSON without delaying the synchronous recall UI contract.
    void restoreComposerAttachments(targetUserMsg.attachments).then((hydrated) => {
      const current = useUIStore.getState().composerDrafts[currentConvId]
      const expected = restoredAttachments.map((attachment) => attachment.attachmentId ?? attachment.name).join('|')
      const actual = current?.attachments.map((attachment) => attachment.attachmentId ?? attachment.name).join('|')
      if (actual === expected) setComposerDraft(currentConvId, { attachments: hydrated })
    })

    return targetUserMsg
  }, [truncateMessagesFrom])


  const regenerate = useCallback(() => {
    if (isStreaming || messages.length < 2) return

    // 找到最后一条用户消息
    let lastUserMsgIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMsgIndex = i
        break
      }
    }
    if (lastUserMsgIndex === -1) return

    const lastUserMsg = messages[lastUserMsgIndex]
    const lastUserContent = lastUserMsg.content
    const previousAssistant = messages[lastUserMsgIndex + 1]?.role === 'assistant'
      ? messages[lastUserMsgIndex + 1]
      : undefined
    const lastAttachments = messageAttachmentsToComposer(lastUserMsg.attachments)
    const unrecoverableAttachment = lastAttachments?.find((att) => !isComposerAttachmentRecoverable(att))
    if (unrecoverableAttachment) {
      setError(new Error(`附件「${unrecoverableAttachment.name}」已无法恢复，请撤回消息后重新选择文件`))
      return
    }
    const requestContext = lastUserMsg.requestContext ?? previousAssistant?.agentContext

    // 从 store 中移除最后一条 assistant 消息
    const currentConvId = convIdRef.current
    if (currentConvId) {
      removeLastMessageFromConversation(currentConvId)
    }

    // 更新本地 state
    setMessages((prev) => prev.slice(0, -1))

    // 重新发送
    void sendMessage(
      lastUserContent,
      lastAttachments,
      requestContext?.skillSystemPrompt,
      requestContext?.skillSkipConfirmation,
      undefined,
      undefined,
      requestContext?.skillId ?? lastUserMsg.skill?.id,
      lastUserMsg.skill?.name,
    )
  }, [messages, isStreaming, sendMessage, removeLastMessageFromConversation])

  const retry = useCallback(() => {
    if (isStreaming || messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    const failedAgent = lastMsg.role === 'assistant' && lastMsg.agentRun?.status === 'failed'
    const userIndex = failedAgent ? messages.length - 2 : messages.length - 1
    const userMsg = messages[userIndex]
    if (userMsg?.role !== 'user') return

    const content = userMsg.content
    const failedAssistant = failedAgent ? lastMsg : undefined
    const lastAttachments = messageAttachmentsToComposer(userMsg.attachments)
    const unrecoverableAttachment = lastAttachments?.find((att) => !isComposerAttachmentRecoverable(att))
    if (unrecoverableAttachment) {
      setError(new Error(`附件「${unrecoverableAttachment.name}」已无法恢复，请撤回消息后重新选择文件`))
      return
    }
    const requestContext = userMsg.requestContext ?? failedAssistant?.agentContext
    setError(null)

    // sendMessage creates a fresh user/assistant pair. A failed recovered
    // assistant therefore removes both itself and its preceding user message.
    const removeCount = failedAgent ? 2 : 1
    const retainedMessages = messages.slice(0, -removeCount)
    setMessages(retainedMessages)
    if (convIdRef.current) {
      for (let index = 0; index < removeCount; index++) {
        removeLastMessageFromConversation(convIdRef.current)
      }
    }

    void sendMessage(
      content,
      lastAttachments,
      requestContext?.skillSystemPrompt,
      requestContext?.skillSkipConfirmation,
      undefined,
      failedAgent ? retainedMessages : undefined,
      requestContext?.skillId ?? userMsg.skill?.id,
      userMsg.skill?.name,
    )
  }, [messages, isStreaming, sendMessage, removeLastMessageFromConversation])

  // During a route transition React can render once before the conversation
  // loading effect runs. Hide the previous conversation's local state in that
  // frame, and never expose its stream status to the new composer.
  const visibleMessages = messagesOwnerRef.current === conversationId
    ? messages.filter((message) => !isDiscardableEmptyAssistant(
        message,
        artifacts.some((artifact) => artifact.messageId === message.id),
      ))
    : []
  const visibleStreaming = streamConversationRef.current === conversationId ? isStreaming : false
  return {
    messages: visibleMessages,
    isStreaming: visibleStreaming,
    error,
    sendMessage,
    stopStreaming,
    recallMessage,
    regenerate,
    retry,
  }
}


interface PptdProgressPreview {
  title: string
  type: 'slides'
  path: string
  content: string
  pageCount: number
}

function getAttachmentFile(att: ComposerAttachment | File): File | undefined {
  if (att instanceof File) return att
  if (att && typeof att === 'object') {
    if ('file' in att && att.file) return att.file
    if (typeof (att as unknown as Blob).slice === 'function' && typeof (att as unknown as File).name === 'string') {
      return att as unknown as File
    }
  }
  return undefined
}

function isImageAttachment(att: ComposerAttachment | File): boolean {
  const file = getAttachmentFile(att)
  if (file) {
    if (file.type && file.type.startsWith('image/')) return true
    if (file.name && /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) return true
  }
  if ('name' in att && att.name && /\.(png|jpe?g|gif|webp|svg)$/i.test(att.name)) return true
  return false
}

async function collectPptdAttachmentMedia(
  composerAttachments: readonly ComposerAttachment[],
): Promise<{ attachmentMedia: Record<string, string>; mediaUrls: Record<number, string>; mediaIds: Record<number, string> }> {
  const attachmentMedia: Record<string, string> = {}
  const mediaUrls: Record<number, string> = {}
  const mediaIds: Record<number, string> = {}

  for (let i = 0; i < composerAttachments.length; i++) {
    const att = composerAttachments[i]
    let mediaUrl = att.mediaUrl
    if (!mediaUrl && att.mediaId) mediaUrl = await loadAttachmentMedia(att.mediaId)
    const file = getAttachmentFile(att)

    if (!mediaUrl && file && isImageAttachment(file)) {
      try {
        mediaUrl = await fileDataUrl(file)
      } catch (e) {
        console.warn('读取图片 Data URL 失败:', e)
      }
    }

    if (mediaUrl) {
      const mediaId = att.mediaId ?? await saveAttachmentMedia(mediaUrl)
      mediaUrls[i] = mediaUrl
      mediaIds[i] = mediaId
      attachmentMedia[attachmentMediaPath(mediaId, att.name)] = mediaUrl
    } else if (isImageAttachment(att)) {
      throw new Error(`图片附件无法恢复：${att.name}`)
    }
  }

  return { attachmentMedia, mediaUrls, mediaIds }
}

async function rebuildPptdAttachmentMedia(
  resources: readonly AttachmentResource[],
  current?: Readonly<Record<string, string | Uint8Array>>,
): Promise<Record<string, string | Uint8Array> | undefined> {
  const media: Record<string, string | Uint8Array> = { ...(current ?? {}) }
  await Promise.all(resources.map(async (resource) => {
    if (!resource.mediaId) return
    const path = attachmentMediaPath(resource.mediaId, resource.name)
    const existing = Object.hasOwn(media, path)
    if (existing) return
    const mediaUrl = resource.mediaUrl ?? await loadAttachmentMedia(resource.mediaId)
    if (!mediaUrl) return
    media[path] = mediaUrl
  }))
  return Object.keys(media).length > 0 ? media : undefined
}

async function restoreComposerAttachments(attachments?: readonly MessageAttachment[]): Promise<ComposerAttachment[]> {
  if (!attachments?.length) return []
  return Promise.all(attachments.map(async (attachment) => {
    const resource = attachment.attachmentId
      ? await loadAttachmentResource(attachment.attachmentId)
      : undefined
    const restored: ComposerAttachment = {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      size: attachment.size,
      mimeType: attachment.mimeType,
      extractedText: resource?.text ?? attachment.extractedText,
      mediaUrl: resource?.mediaUrl ?? attachment.mediaUrl,
      mediaId: resource?.mediaId ?? attachment.mediaId,
      recoverable: attachment.recoverable,
    }
    restored.recoverable = isComposerAttachmentRecoverable(restored)
    return restored
  }))
}

function messageAttachmentsToComposer(attachments?: readonly MessageAttachment[]): ComposerAttachment[] {
  return (attachments ?? []).map((attachment) => {
    const restored: ComposerAttachment = {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      size: attachment.size,
      mimeType: attachment.mimeType,
      extractedText: attachment.extractedText,
      mediaUrl: attachment.mediaUrl,
      mediaId: attachment.mediaId,
      recoverable: attachment.recoverable,
    }
    restored.recoverable = isComposerAttachmentRecoverable(restored)
    return restored
  })
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(`无法读取图片 ${file.name}`))
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取图片 ${file.name}`))
    reader.readAsDataURL(file)
  })
}

function getPptdProgressPreview(event: QueryEvent): PptdProgressPreview | undefined {
  if (event.type !== 'tool.progress' || !event.progress.phase.startsWith('pptd_')) return undefined
  const detail = event.progress.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined
  const preview = (detail as { preview?: unknown }).preview
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return undefined
  const candidate = preview as Record<string, unknown>
  if (
    typeof candidate.title !== 'string'
    || candidate.type !== 'slides'
    || typeof candidate.path !== 'string'
    || typeof candidate.content !== 'string'
    || typeof candidate.pageCount !== 'number'
  ) return undefined
  return candidate as unknown as PptdProgressPreview
}

function withoutPptdPreview(event: Extract<QueryEvent, { type: 'tool.progress' }>): QueryEvent {
  const detail = event.progress.detail as Record<string, unknown>
  const { preview: _preview, ...progressDetail } = detail
  return {
    ...event,
    progress: { ...event.progress, detail: progressDetail },
  }
}
