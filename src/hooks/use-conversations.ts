import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getConversations,
  createConversation,
  updateConversation,
  deleteConversation,
  type CreateConversationInput,
  type UpdateConversationInput,
} from '@/lib/api'
import { toast } from '@/stores/toast-store'

/**
 * 获取项目下的对话列表
 */
export function useConversations(projectId: string | undefined) {
  return useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => getConversations(projectId!),
    enabled: !!projectId,
  })
}

/**
 * 创建对话
 */
export function useCreateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateConversationInput) => createConversation(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', data.project_id] })
    },
    onError: (error: Error) => {
      toast.error(`创建对话失败: ${error.message}`)
    },
  })
}

/**
 * 更新对话
 */
export function useUpdateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateConversationInput }) =>
      updateConversation(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
    onError: (error: Error) => {
      toast.error(`更新对话失败: ${error.message}`)
    },
  })
}

/**
 * 删除对话
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['messages'] })
      queryClient.invalidateQueries({ queryKey: ['artifacts'] })
      toast.success('对话已删除')
    },
    onError: (error: Error) => {
      toast.error(`删除对话失败: ${error.message}`)
    },
  })
}
