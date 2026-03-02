import { supabase } from '@/lib/supabase'
import type { Project } from './types'

export interface CreateProjectInput {
  name: string
  description?: string
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  status?: 'active' | 'archived'
}

/**
 * 获取当前用户的所有项目
 */
export async function getProjects(): Promise<Project[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

/**
 * 获取单个项目
 */
export async function getProject(id: string): Promise<Project> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

/**
 * 创建项目
 */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: input.name,
      description: input.description ?? null,
      owner_id: user.id,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 更新项目
 */
export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('projects')
    .update(input)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 删除项目（级联删除所有对话、消息、Artifacts）
 */
export async function deleteProject(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id)

  if (error) throw error
}

/**
 * 归档项目
 */
export async function archiveProject(id: string): Promise<Project> {
  return updateProject(id, { status: 'archived' })
}

/**
 * 恢复项目
 */
export async function unarchiveProject(id: string): Promise<Project> {
  return updateProject(id, { status: 'active' })
}
