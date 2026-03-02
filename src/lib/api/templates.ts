/**
 * 模板 API
 * 提供模板的 CRUD 操作
 */

import { supabase } from '../supabase'
import type { Template } from './types'

export interface CreateTemplateInput {
  name: string
  description?: string
  content: string
  variables: Template['variables']
  skill_id?: string
  project_id?: string
  is_public?: boolean
}

export interface UpdateTemplateInput {
  name?: string
  description?: string
  content?: string
  variables?: Template['variables']
  skill_id?: string
  is_public?: boolean
}

/**
 * 获取用户的模板列表
 * @param options 筛选选项
 */
export async function getTemplates(options?: {
  skill_id?: string
  project_id?: string
  include_public?: boolean
}) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  let query = supabase
    .from('templates')
    .select('*')
    .order('created_at', { ascending: false })

  // 构建查询条件：自己的模板 OR 公开模板
  if (options?.include_public !== false) {
    query = query.or(`owner_id.eq.${user.id},is_public.eq.true`)
  } else {
    query = query.eq('owner_id', user.id)
  }

  // 按技能筛选
  if (options?.skill_id) {
    query = query.eq('skill_id', options.skill_id)
  }

  // 按项目筛选
  if (options?.project_id !== undefined) {
    if (options.project_id === null) {
      query = query.is('project_id', null)
    } else {
      query = query.eq('project_id', options.project_id)
    }
  }

  const { data, error } = await query

  if (error) throw error
  return data as Template[]
}

/**
 * 获取单个模板
 */
export async function getTemplate(id: string) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data as Template
}

/**
 * 创建模板
 */
export async function createTemplate(input: CreateTemplateInput) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  const { data, error } = await supabase
    .from('templates')
    .insert({
      owner_id: user.id,
      name: input.name,
      description: input.description || null,
      content: input.content,
      variables: input.variables,
      skill_id: input.skill_id || null,
      project_id: input.project_id || null,
      is_public: input.is_public || false,
    })
    .select()
    .single()

  if (error) throw error
  return data as Template
}

/**
 * 更新模板
 */
export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  const { data, error } = await supabase
    .from('templates')
    .update({
      name: input.name,
      description: input.description,
      content: input.content,
      variables: input.variables,
      skill_id: input.skill_id,
      is_public: input.is_public,
    })
    .eq('id', id)
    .eq('owner_id', user.id) // 只能更新自己的模板
    .select()
    .single()

  if (error) throw error
  return data as Template
}

/**
 * 删除模板
 */
export async function deleteTemplate(id: string) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  const { error } = await supabase
    .from('templates')
    .delete()
    .eq('id', id)
    .eq('owner_id', user.id) // 只能删除自己的模板

  if (error) throw error
}

/**
 * 增加模板使用次数
 */
export async function incrementTemplateUsage(id: string) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase.rpc('increment_template_usage', {
    template_id: id,
  })

  if (error) {
    // 如果 RPC 函数不存在，使用 fallback 方式
    const { data: template } = await supabase
      .from('templates')
      .select('usage_count')
      .eq('id', id)
      .single()

    if (template) {
      await supabase
        .from('templates')
        .update({ usage_count: template.usage_count + 1 })
        .eq('id', id)
    }
  }
}

/**
 * 复制模板（从公开模板创建自己的副本）
 */
export async function duplicateTemplate(id: string) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  // 获取原模板
  const original = await getTemplate(id)

  // 创建副本
  return createTemplate({
    name: `${original.name} (副本)`,
    description: original.description || undefined,
    content: original.content,
    variables: original.variables,
    skill_id: original.skill_id || undefined,
    is_public: false,
  })
}
