/**
 * 模板管理 Hook
 * 封装模板 CRUD 操作
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  incrementTemplateUsage,
  type CreateTemplateInput,
  type UpdateTemplateInput,
} from '@/lib/api/templates'
import { toast } from '@/stores/toast-store'

/**
 * 获取模板列表
 */
export function useTemplates(options?: {
  skill_id?: string
  project_id?: string
  include_public?: boolean
}) {
  return useQuery({
    queryKey: ['templates', options],
    queryFn: () => getTemplates(options),
    staleTime: 1000 * 60 * 5, // 5 分钟
  })
}

/**
 * 获取单个模板
 */
export function useTemplate(id: string | null) {
  return useQuery({
    queryKey: ['templates', id],
    queryFn: () => getTemplate(id!),
    enabled: !!id,
  })
}

/**
 * 创建模板
 */
export function useCreateTemplate() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateTemplateInput) => createTemplate(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      toast.success('模板已创建')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })
}

/**
 * 更新模板
 */
export function useUpdateTemplate() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) =>
      updateTemplate(id, input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      queryClient.invalidateQueries({ queryKey: ['templates', variables.id] })
      toast.success('模板已更新')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })
}

/**
 * 删除模板
 */
export function useDeleteTemplate() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      toast.success('模板已删除')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })
}

/**
 * 复制模板
 */
export function useDuplicateTemplate() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => duplicateTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      toast.success('模板已复制到你的列表')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })
}

/**
 * 增加模板使用次数
 */
export function useIncrementTemplateUsage() {
  return useMutation({
    mutationFn: (id: string) => incrementTemplateUsage(id),
  })
}
