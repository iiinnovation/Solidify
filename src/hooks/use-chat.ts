import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchChatStream, compressMessages } from '@/lib/chat-api'
import { useChatStore, type ArtifactType, type Message } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useProjectStore } from '@/stores/project-store'
import { sendNotification } from '@/lib/tauri'
import { newId } from '@/lib/id'
import { isEnabled } from '@/lib/harness/flags'
import { runQuery } from '@/lib/engine/query'
import { applyRunEvent, createRunState } from '@/lib/engine/run-state'
import { createChatQueryContext } from '@/lib/engine/chat-context'
import type { QueryEvent } from '@/lib/engine/types'
import { useWorkspaceStore } from '@/stores/workspace-store'

function genId() {
  return newId('msg')
}

interface ResumeRunOptions {
  conversationId: string
  assistantMessage: Message
}

/* ── 流式 Artifact 解析 ── */

// AI 可能输出 diagram / flowchart 等旧类型，统一映射到合法 ArtifactType
const typeAliasMap: Record<string, ArtifactType> = {
  diagram: 'mermaid',
  flowchart: 'mermaid',
  flow: 'mermaid',
  sequence: 'mermaid',
  graph: 'mermaid',
  bar: 'chart',
  line: 'chart',
  pie: 'chart',
}

function normalizeArtifactType(raw: string): ArtifactType {
  const lower = raw.toLowerCase().trim()
  if (['document', 'slides', 'code', 'mermaid', 'chart', 'drawio'].includes(lower)) {
    return lower as ArtifactType
  }
  return typeAliasMap[lower] ?? 'document'
}

interface StreamingArtifactInfo {
  title: string
  type: ArtifactType
  content: string
}

function processStreamingContent(fullContent: string) {
  const completeRegex =
    /<solidify-artifact\s+title="([^"]+)"\s+type="([^"]+)">([\s\S]*?)<\/solidify-artifact>/g

  const completeArtifacts: StreamingArtifactInfo[] = []
  let match
  while ((match = completeRegex.exec(fullContent)) !== null) {
    completeArtifacts.push({
      title: match[1],
      type: normalizeArtifactType(match[2]),
      content: match[3].trim(),
    })
  }

  // 移除完整的 artifact 块
  let cleanText = fullContent.replace(completeRegex, '')

  // 检测未闭合的（正在流式传输的）artifact
  const partialRegex =
    /<solidify-artifact\s+title="([^"]+)"\s+type="([^"]+)">([\s\S]*)$/
  const partialMatch = cleanText.match(partialRegex)

  let streamingArtifact: StreamingArtifactInfo | null = null
  if (partialMatch) {
    streamingArtifact = {
      title: partialMatch[1],
      type: normalizeArtifactType(partialMatch[2]),
      content: partialMatch[3],
    }
    cleanText = cleanText.replace(partialRegex, '')
  }

  // 清理多余空行
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim()

  return { cleanText, completeArtifacts, streamingArtifact }
}

/* ── Hook ── */

export function useChat(conversationId?: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resumedConversationsRef = useRef(new Set<string>())
  const navigate = useNavigate()

  const addArtifact = useChatStore((s) => s.addArtifact)
  const updateArtifactContent = useChatStore((s) => s.updateArtifactContent)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessageToConversation = useChatStore((s) => s.addMessageToConversation)
  const patchMessageInConversation = useChatStore((s) => s.patchMessageInConversation)
  const removeLastMessageFromConversation = useChatStore((s) => s.removeLastMessageFromConversation)
  const getActiveProvider = useModelStore((s) => s.getActiveProvider)

  // 从 store 加载已有对话
  useEffect(() => {
    if (conversationId) {
      const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
      if (conv) {
        setMessages(conv.messages)
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
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  // 跟踪当前 conversationId（sendMessage 闭包中需要最新值）
  const convIdRef = useRef(conversationId)
  convIdRef.current = conversationId

  const sendMessage = useCallback(
    async (
      content: string,
      files?: File[],
      skillSystemPrompt?: string,
      skillSkipConfirmation?: boolean,
      resume?: ResumeRunOptions,
      historyOverride?: Message[],
    ) => {
      if ((!content.trim() && !resume) || isStreaming) return

      setError(null)

      const savedProviderId = resume?.assistantMessage.agentContext?.providerId
      const activeProvider = savedProviderId
        ? useModelStore.getState().providers.find((provider) => provider.id === savedProviderId) ?? null
        : getActiveProvider()
      if (!activeProvider) {
        const providerError = new Error(savedProviderId
          ? '无法恢复 Agent：原 Provider 已被删除'
          : '请先在设置中配置 AI 模型')
        setError(providerError)
        if (resume?.assistantMessage.agentRun) {
          const failureEvent: QueryEvent = {
            type: 'run.failed',
            error: { kind: 'internal', message: providerError.message },
          }
          const failedRun = applyRunEvent(resume.assistantMessage.agentRun, failureEvent)
          const runEvents = [...(resume.assistantMessage.runEvents ?? []), failureEvent]
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

      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content,
        attachments: files?.map(f => ({ name: f.name, size: f.size }))
      }
      const assistantMsg: Message = resume?.assistantMessage
        ?? { id: genId(), role: 'assistant', content: '' }

      // 处理文件附件
      let enrichedContent = content
      if (files && files.length > 0) {
        try {
          const { extractText } = await import('@/lib/file-extractor')
          const fileContents = await Promise.all(
            files.map(file => extractText(file))
          )
          enrichedContent = `${content}\n\n## 附件内容\n\n${fileContents.map((text, i) =>
            `### ${files[i].name}\n\n${text}`
          ).join('\n\n')}`
        } catch (error) {
          console.error('文件内容提取失败:', error)
        }
      }

      // 知识库增强：搜索相关知识
      let knowledgeContext = ''
      let knowledgeSources: Array<{ id: string; title: string; similarity: number }> = []
      const knowledgeEnabled = useKnowledgeEnhancementStore.getState().enabled
      const matchCount = useKnowledgeEnhancementStore.getState().matchCount
      const matchThreshold = useKnowledgeEnhancementStore.getState().matchThreshold
      const activeProjectId = useProjectStore.getState().activeProjectId
      const addRecentSource = useKnowledgeEnhancementStore.getState().addRecentSource

      // 检查是否启用知识库功能（环境变量控制）
      const enableKnowledge = import.meta.env.VITE_ENABLE_KNOWLEDGE !== 'false'

      if (!resume && knowledgeEnabled && enableKnowledge) {
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
            knowledgeSources = knowledgeResults.map(result => ({
              id: result.id,
              title: result.title,
              similarity: result.similarity,
            }))

            // 构建知识上下文
            knowledgeContext = `

## 相关知识库内容

${knowledgeResults.map((result, index) => `
### [${index + 1}] ${result.title}
${result.content}
`).join('\n')}

---

请基于以上知识库内容回答用户问题。如果知识库内容与问题相关，请引用相关内容。
`
          }
        } catch (error) {
          console.error('知识库搜索失败:', error)
          // 搜索失败不影响正常对话
        }
      }

      // 将知识上下文添加到用户消息中
      if (knowledgeContext) {
        enrichedContent = `${enrichedContent}${knowledgeContext}`
      }

      // 更新本地 state + store
      if (!resume) {
        setMessages((prev) => [...prev, userMsg, assistantMsg])
        addMessageToConversation(currentConvId, userMsg)
        addMessageToConversation(currentConvId, assistantMsg)
      }

      setIsStreaming(true)

      const abortController = new AbortController()
      abortRef.current = abortController

      // 流式 artifact 跟踪
      let streamingArtifactId: string | null = null
      let completedArtifactCount = resume
        ? processStreamingContent(assistantMsg.agentRun?.text ?? '').completeArtifacts.length
        : 0

      /**
       * `persist: false` updates only the local view. The conversation store is
       * `persist()`-backed, so every write there re-serializes the whole
       * conversation tree into localStorage — doing that once per streamed token
       * is both O(n²) and a fast route to the storage quota.
       */
      const patchAssistantMessage = (patch: Partial<Message>, persist = true) => {
        setMessages((prev) => prev.map((message) =>
          message.id === assistantMsg.id ? { ...message, ...patch } : message,
        ))
        if (persist) patchMessageInConversation(currentConvId, assistantMsg.id, patch)
      }

      const consumeArtifactContent = (fullContent: string, final = false, persist = true) => {
        const { cleanText, completeArtifacts, streamingArtifact } =
          processStreamingContent(fullContent)

        while (completedArtifactCount < completeArtifacts.length) {
          const artifact = completeArtifacts[completedArtifactCount]
          if (streamingArtifactId) {
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
          if (!streamingArtifactId) {
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

        patchAssistantMessage({
          content: cleanText,
          ...(final && knowledgeSources.length > 0 ? { knowledgeSources } : {}),
        }, persist)
        return cleanText
      }

      try {
        const baseMessages = resume ? messages : historyOverride ?? messages
        const allMessages = (resume ? baseMessages : [...baseMessages, userMsg]).map((m) => ({
          role: m.role,
          content: m.content,
        }))

        // 应用上下文压缩：保留首轮 + 最近 10 轮
        const apiMessages = compressMessages(allMessages, 10)

        // 使用增强后的内容（包含文件内容）
        const messagesWithFiles = [...apiMessages]
        if (enrichedContent !== content) {
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
          }
          patchAssistantMessage({ agentRun: run, runEvents, agentContext })

          const context = createChatQueryContext({
            runId,
            conversationId: currentConvId,
            messages: messagesWithFiles,
            provider: activeProvider,
            signal: abortController.signal,
            skillSystemPrompt: agentContext.skillSystemPrompt,
            skillSkipConfirmation: agentContext.skillSkipConfirmation,
            workspaceRoot: agentContext.workspaceRoot,
            restoreSnapshot: Boolean(resume),
          })

          let latestText: string | undefined
          for await (const event of runQuery(context)) {
            // Deltas and progress ticks are transient UI signal, not run facts:
            // the text is already accumulated into `run.text` by applyRunEvent.
            // Persisting them grew runEvents without bound and made every patch
            // copy an ever-larger array into localStorage.
            const isDurableFact = event.type !== 'message.delta' && event.type !== 'tool.progress'
            if (isDurableFact) runEvents.push(event)
            run = applyRunEvent(run, event)
            if (event.type === 'message.delta' || event.type === 'message.completed') {
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

          const finalText = consumeArtifactContent(run.text, true)
          patchAssistantMessage({
            ...(finalText !== undefined ? { content: finalText } : {}),
            agentRun: run,
            runEvents: [...runEvents],
          })
          return
        }

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
            errData?.error?.message ?? `请求失败: ${response.status}`,
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
                fullContent += delta
                consumeArtifactContent(fullContent)
              }
            } catch {
              // 非 JSON 行，跳过
            }
          }
        }

        reader.releaseLock()

        consumeArtifactContent(fullContent, true)
      } catch (err) {
        if (abortController.signal.aborted) return
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
        setIsStreaming(false)
        abortRef.current = null
        // 窗口不在前台时发送系统通知
        if (document.hidden) {
          sendNotification('Solidify', 'AI 回复已生成')
        }
      }
    },
    [messages, isStreaming, addArtifact, updateArtifactContent, createConversation, addMessageToConversation, patchMessageInConversation, removeLastMessageFromConversation, navigate, getActiveProvider],
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

    const lastUserContent = messages[lastUserMsgIndex].content

    // 从 store 中移除最后一条 assistant 消息
    const currentConvId = convIdRef.current
    if (currentConvId) {
      removeLastMessageFromConversation(currentConvId)
    }

    // 更新本地 state
    setMessages((prev) => prev.slice(0, -1))

    // 重新发送
    sendMessage(lastUserContent)
  }, [messages, isStreaming, sendMessage, removeLastMessageFromConversation])

  const retry = useCallback(() => {
    if (isStreaming || messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    const failedAgent = lastMsg.role === 'assistant' && lastMsg.agentRun?.status === 'failed'
    const userIndex = failedAgent ? messages.length - 2 : messages.length - 1
    const userMsg = messages[userIndex]
    if (userMsg?.role !== 'user') return

    const content = userMsg.content
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
      undefined,
      undefined,
      undefined,
      undefined,
      failedAgent ? retainedMessages : undefined,
    )
  }, [messages, isStreaming, sendMessage, removeLastMessageFromConversation])

  return { messages, isStreaming, error, sendMessage, stopStreaming, regenerate, retry }
}
