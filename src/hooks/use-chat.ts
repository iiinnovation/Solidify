import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchChatStream, compressMessages } from '@/lib/chat-api'
import { useChatStore, type ArtifactType, type Message } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useProjectStore } from '@/stores/project-store'
import { sendNotification } from '@/lib/tauri'

let messageIdCounter = 0
function genId() {
  return `msg-${Date.now()}-${++messageIdCounter}`
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
  const navigate = useNavigate()

  const addArtifact = useChatStore((s) => s.addArtifact)
  const updateArtifactContent = useChatStore((s) => s.updateArtifactContent)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessageToConversation = useChatStore((s) => s.addMessageToConversation)
  const updateMessageInConversation = useChatStore((s) => s.updateMessageInConversation)
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
    async (content: string, files?: File[], skillSystemPrompt?: string, skillSkipConfirmation?: boolean) => {
      if (!content.trim() || isStreaming) return

      setError(null)

      const activeProvider = getActiveProvider()
      if (!activeProvider) {
        setError(new Error('请先在设置中配置 AI 模型'))
        return
      }

      // 确定对话 ID —— 没有则新建
      let currentConvId = convIdRef.current
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
      const assistantMsg: Message = { id: genId(), role: 'assistant', content: '' }

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

      if (knowledgeEnabled && enableKnowledge) {
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
      setMessages((prev) => [...prev, userMsg, assistantMsg])
      addMessageToConversation(currentConvId, userMsg)
      addMessageToConversation(currentConvId, assistantMsg)

      setIsStreaming(true)

      const abortController = new AbortController()
      abortRef.current = abortController

      // 流式 artifact 跟踪
      let streamingArtifactId: string | null = null
      let completedArtifactCount = 0

      try {
        const allMessages = [...messages, userMsg].map((m) => ({
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

                // 增量 artifact 解析
                const { cleanText, completeArtifacts, streamingArtifact } =
                  processStreamingContent(fullContent)

                // 处理新完成的 artifact
                while (completedArtifactCount < completeArtifacts.length) {
                  const art = completeArtifacts[completedArtifactCount]
                  if (streamingArtifactId) {
                    // 正在流式传输的 artifact 完成了 → 用最终内容更新
                    updateArtifactContent(streamingArtifactId, art.content, false)
                    streamingArtifactId = null
                  } else {
                    addArtifact({
                      id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      title: art.title,
                      type: art.type,
                      content: art.content,
                      messageId: assistantMsg.id,
                      version: 1,
                    })
                  }
                  completedArtifactCount++
                }

                // 处理正在流式传输的 artifact
                if (streamingArtifact) {
                  if (!streamingArtifactId) {
                    const newId = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
                    addArtifact({
                      id: newId,
                      title: streamingArtifact.title,
                      type: streamingArtifact.type,
                      content: streamingArtifact.content,
                      messageId: assistantMsg.id,
                      version: 1,
                      streaming: true,
                    })
                    streamingArtifactId = newId
                  } else {
                    updateArtifactContent(streamingArtifactId, streamingArtifact.content, true)
                  }
                }

                // 更新消息为干净文本（去除 artifact 标记）
                setMessages((prev) => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    content: cleanText,
                  }
                  return updated
                })
                updateMessageInConversation(currentConvId!, assistantMsg.id, cleanText)
              }
            } catch {
              // 非 JSON 行，跳过
            }
          }
        }

        reader.releaseLock()

        // 流结束后最终解析（安全网）
        const { cleanText, completeArtifacts } = processStreamingContent(fullContent)

        while (completedArtifactCount < completeArtifacts.length) {
          const art = completeArtifacts[completedArtifactCount]
          if (streamingArtifactId) {
            updateArtifactContent(streamingArtifactId, art.content, false)
            streamingArtifactId = null
          } else {
            addArtifact({
              id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              title: art.title,
              type: art.type,
              content: art.content,
              messageId: assistantMsg.id,
              version: 1,
            })
          }
          completedArtifactCount++
        }

        // 如果流中断时 artifact 仍在传输，标记为完成
        if (streamingArtifactId) {
          updateArtifactContent(streamingArtifactId, useChatStore.getState().artifacts.find(a => a.id === streamingArtifactId)?.content ?? '', false)
        }

        // 最终更新消息内容（包含知识来源）
        setMessages((prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: cleanText,
            knowledgeSources: knowledgeSources.length > 0 ? knowledgeSources : undefined,
          }
          return updated
        })

        // 更新 store 中的消息
        if (currentConvId) {
          const conv = useChatStore.getState().conversations.find((c) => c.id === currentConvId)
          if (conv) {
            const msgIndex = conv.messages.findIndex(m => m.id === assistantMsg.id)
            if (msgIndex !== -1) {
              const updatedMessages = [...conv.messages]
              updatedMessages[msgIndex] = {
                ...updatedMessages[msgIndex],
                content: cleanText,
                knowledgeSources: knowledgeSources.length > 0 ? knowledgeSources : undefined,
              }
              useChatStore.setState((state) => ({
                conversations: state.conversations.map(c =>
                  c.id === currentConvId ? { ...c, messages: updatedMessages } : c
                )
              }))
            }
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) return
        const error = err instanceof Error ? err : new Error('未知错误')
        setError(error)
        // 移除空的 assistant 消息
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
    [messages, isStreaming, addArtifact, updateArtifactContent, createConversation, addMessageToConversation, updateMessageInConversation, removeLastMessageFromConversation, navigate, getActiveProvider],
  )

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
    setIsStreaming(false)
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
    // 错误后，空的 assistant 消息已被移除，最后一条应该是发送失败的用户消息
    const lastMsg = messages[messages.length - 1]
    if (lastMsg.role !== 'user') return

    const content = lastMsg.content
    setError(null)

    // 移除失败的用户消息，sendMessage 会重新添加
    setMessages((prev) => prev.slice(0, -1))
    if (convIdRef.current) {
      removeLastMessageFromConversation(convIdRef.current)
    }

    sendMessage(content)
  }, [messages, isStreaming, sendMessage, removeLastMessageFromConversation])

  return { messages, isStreaming, error, sendMessage, stopStreaming, regenerate, retry }
}
