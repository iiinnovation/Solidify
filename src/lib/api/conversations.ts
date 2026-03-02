import { supabase } from '@/lib/supabase'
import type { Conversation } from './types'

export interface CreateConversationInput {
  project_id: string
  title: string
}

export interface UpdateConversationInput {
  title?: string
}

/**
 * 获取项目下的所有对话
 */
export async function getConversations(projectId: string): Promise<Conversation[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

/**
 * 获取单个对话
 */
export async function getConversation(id: string): Promise<Conversation> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

/**
 * 创建对话
 */
export async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      project_id: input.project_id,
      title: input.title,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 更新对话
 */
export async function updateConversation(id: string, input: UpdateConversationInput): Promise<Conversation> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('conversations')
    .update(input)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 删除对话（级联删除所有消息和 Artifacts）
 */
export async function deleteConversation(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', id)

  if (error) throw error
}
