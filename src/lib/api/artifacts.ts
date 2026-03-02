import { supabase } from '@/lib/supabase'
import type { Artifact } from './types'

export interface CreateArtifactInput {
  conversation_id: string
  message_id: string
  title: string
  type: 'document' | 'slides' | 'code' | 'mermaid' | 'chart' | 'drawio'
  content: string
  version?: number
}

export interface UpdateArtifactInput {
  content?: string
  version?: number
}

/**
 * 获取对话的所有 Artifacts（仅元数据，不含 content）
 */
export async function getArtifacts(conversationId: string): Promise<Omit<Artifact, 'content'>[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .select('id, conversation_id, message_id, title, type, version, created_at, updated_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data
}

/**
 * 获取对话的所有 Artifacts（包含完整内容）
 */
export async function getArtifactsWithContent(conversationId: string): Promise<Artifact[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data
}

/**
 * 获取单个 Artifact（完整内容）
 */
export async function getArtifact(id: string): Promise<Artifact> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

/**
 * 获取单个 Artifact 的内容（仅 content 字段）
 */
export async function getArtifactContent(id: string): Promise<string> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .select('content')
    .eq('id', id)
    .single()

  if (error) throw error
  return data.content
}

/**
 * 创建 Artifact
 */
export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .insert({
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      title: input.title,
      type: input.type,
      content: input.content,
      version: input.version ?? 1,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 更新 Artifact 内容
 */
export async function updateArtifact(id: string, input: UpdateArtifactInput): Promise<Artifact> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .update(input)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 删除 Artifact
 */
export async function deleteArtifact(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase
    .from('artifacts')
    .delete()
    .eq('id', id)

  if (error) throw error
}

/**
 * 批量创建 Artifacts（用于迁移 localStorage 数据）
 */
export async function createArtifactsBatch(inputs: CreateArtifactInput[]): Promise<Artifact[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('artifacts')
    .insert(inputs.map(input => ({
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      title: input.title,
      type: input.type,
      content: input.content,
      version: input.version ?? 1,
    })))
    .select()

  if (error) throw error
  return data
}
