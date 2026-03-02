import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getArtifacts,
  getArtifactsWithContent,
  getArtifactContent,
  createArtifact,
  updateArtifact,
  type CreateArtifactInput,
  type UpdateArtifactInput,
} from '@/lib/api'
import { toast } from '@/stores/toast-store'

/**
 * 获取对话的 Artifacts 列表（仅元数据，懒加载优化）
 */
export function useArtifacts(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['artifacts', conversationId],
    queryFn: () => getArtifacts(conversationId!),
    enabled: !!conversationId,
  })
}

/**
 * 获取对话的 Artifacts 列表（包含完整内容）
 */
export function useArtifactsWithContent(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['artifacts-full', conversationId],
    queryFn: () => getArtifactsWithContent(conversationId!),
    enabled: !!conversationId,
  })
}

/**
 * 获取单个 Artifact 的内容（按需加载）
 */
export function useArtifactContent(artifactId: string | undefined) {
  return useQuery({
    queryKey: ['artifact-content', artifactId],
    queryFn: () => getArtifactContent(artifactId!),
    enabled: !!artifactId,
    staleTime: 10 * 60 * 1000, // 10 分钟内不重新获取
  })
}

/**
 * 创建 Artifact
 */
export function useCreateArtifact() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateArtifactInput) => createArtifact(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['artifacts', data.conversation_id] })
    },
    onError: (error: Error) => {
      toast.error(`保存 Artifact 失败: ${error.message}`)
    },
  })
}

/**
 * 更新 Artifact
 */
export function useUpdateArtifact() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateArtifactInput }) =>
      updateArtifact(id, input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['artifacts', data.conversation_id] })
    },
    onError: (error: Error) => {
      toast.error(`更新 Artifact 失败: ${error.message}`)
    },
  })
}
