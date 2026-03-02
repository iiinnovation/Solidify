/**
 * 数据迁移工具
 * 将 localStorage 中的对话数据迁移到 Supabase
 */

import { useChatStore } from '@/stores/chat-store'
import { useProjectStore } from '@/stores/project-store'
import {
  createConversation,
  createMessage,
  createArtifactsBatch,
  type CreateArtifactInput,
} from '@/lib/api'
import { toast } from '@/stores/toast-store'

interface MigrationResult {
  success: boolean
  conversationsMigrated: number
  messagesMigrated: number
  artifactsMigrated: number
  error?: string
}

/**
 * 迁移 localStorage 数据到 Supabase
 */
export async function migrateLocalDataToCloud(projectId: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    conversationsMigrated: 0,
    messagesMigrated: 0,
    artifactsMigrated: 0,
  }

  try {
    const localConversations = useChatStore.getState().conversations
    const localArtifacts = useChatStore.getState().artifacts

    if (localConversations.length === 0) {
      result.success = true
      return result
    }

    // 迁移每个对话
    for (const localConv of localConversations) {
      try {
        // 1. 创建对话
        const cloudConv = await createConversation({
          project_id: projectId,
          title: localConv.title,
        })
        result.conversationsMigrated++

        // 2. 创建消息（逐个插入以确保 ID 映射正确）
        if (localConv.messages.length > 0) {
          const messageIdMap = new Map<string, string>()

          for (const localMsg of localConv.messages) {
            const cloudMsg = await createMessage({
              conversation_id: cloudConv.id,
              role: localMsg.role,
              content: localMsg.content,
            })
            messageIdMap.set(localMsg.id, cloudMsg.id)
            result.messagesMigrated++
          }

          // 3. 批量创建 Artifacts（使用可靠的 message_id 映射）
          const convArtifacts = localArtifacts.filter((a) =>
            localConv.messages.some((m) => m.id === a.messageId)
          )

          if (convArtifacts.length > 0) {
            const artifactInputs: CreateArtifactInput[] = convArtifacts.map((artifact) => ({
              conversation_id: cloudConv.id,
              message_id: messageIdMap.get(artifact.messageId)!,
              title: artifact.title,
              type: artifact.type,
              content: artifact.content,
              version: artifact.version,
            }))

            const cloudArtifacts = await createArtifactsBatch(artifactInputs)
            result.artifactsMigrated += cloudArtifacts.length
          }
        }
      } catch (error) {
        console.error(`Failed to migrate conversation ${localConv.id}:`, error)
        // 继续迁移其他对话
      }
    }

    result.success = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : '未知错误'
    return result
  }
}

/**
 * 清理已迁移的本地数据
 */
export function clearLocalData() {
  const store = useChatStore.getState()
  // 清空对话和 artifacts
  localStorage.removeItem('solidify-chat')
  // 重置 store
  store.conversations.forEach((conv) => {
    store.deleteConversation(conv.id)
  })
}

/**
 * Hook: 自动迁移数据
 * 在用户首次登录后自动触发
 */
export function useAutoMigration() {
  const { activeProjectId } = useProjectStore()

  const migrate = async () => {
    if (!activeProjectId) return

    const localConversations = useChatStore.getState().conversations
    if (localConversations.length === 0) return

    // 检查是否已经迁移过
    const migrated = localStorage.getItem('solidify-data-migrated')
    if (migrated === 'true') return

    toast.info('正在迁移本地数据到云端...')

    const result = await migrateLocalDataToCloud(activeProjectId)

    if (result.success) {
      toast.success(
        `迁移完成：${result.conversationsMigrated} 个对话，${result.messagesMigrated} 条消息，${result.artifactsMigrated} 个 Artifacts`
      )
      // 标记已迁移
      localStorage.setItem('solidify-data-migrated', 'true')
      // 清理本地数据
      clearLocalData()
    } else {
      toast.error(`迁移失败: ${result.error}`)
    }
  }

  return { migrate }
}
