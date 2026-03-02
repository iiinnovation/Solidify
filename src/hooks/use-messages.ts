import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMessages,
  createMessage,
  updateMessage,
  type CreateMessageInput,
  type UpdateMessageInput,
} from '@/lib/api'
import { toast } from '@/stores/toast-store'

/**
 * 获取对话的消息列表
 */
export function useMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => getMessages(conversationId!),
    enabled: !!conversationId,
  })
}

/**
 * 创建消息
 */
export function useCreateMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateMessageInput) => createMessage(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['messages', data.conversation_id] })
    },
    onError: (error: Error) => {
      toast.error(`保存消息失败: ${error.message}`)
    },
  })
}

/**
 * 更新消息
 */
export function useUpdateMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMessageInput }) =>
      updateMessage(id, input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['messages', data.conversation_id] })
    },
    onError: (error: Error) => {
      toast.error(`更新消息失败: ${error.message}`)
    },
  })
}
