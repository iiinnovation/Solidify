import { supabase } from '@/lib/supabase'
import type { Message } from './types'

export interface CreateMessageInput {
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string
}

export interface UpdateMessageInput {
  content?: string
}

/**
 * 获取对话的所有消息
 */
export async function getMessages(conversationId: string): Promise<Message[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data
}

/**
 * 获取单条消息
 */
export async function getMessage(id: string): Promise<Message> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

/**
 * 创建消息
 */
export async function createMessage(input: CreateMessageInput): Promise<Message> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 更新消息内容（用于流式响应完成后更新）
 */
export async function updateMessage(id: string, input: UpdateMessageInput): Promise<Message> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('messages')
    .update(input)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 删除消息
 */
export async function deleteMessage(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', id)

  if (error) throw error
}

/**
 * 批量创建消息（用于迁移 localStorage 数据）
 */
export async function createMessagesBatch(inputs: CreateMessageInput[]): Promise<Message[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('messages')
    .insert(inputs.map(input => ({
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
    })))
    .select()

  if (error) throw error
  return data
}
