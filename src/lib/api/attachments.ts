import { supabase } from '@/lib/supabase'
import type { FileAttachment } from './types'

/**
 * 上传文件到 Storage 并创建记录
 */
export async function uploadAttachment(
  messageId: string,
  file: File
): Promise<FileAttachment> {
  if (!supabase) throw new Error('Supabase 未配置')

  // 1. 生成唯一路径
  const nameParts = file.name.split('.')
  const ext = nameParts.length > 1 ? nameParts.pop() : ''
  const path = ext
    ? `attachments/${messageId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
    : `attachments/${messageId}/${Date.now()}-${crypto.randomUUID()}`

  // 2. 上传到 Storage
  const { error: storageError } = await supabase.storage
    .from('solidify-files')
    .upload(path, file)

  if (storageError) throw storageError

  // 3. 创建数据库记录
  const { data, error } = await supabase
    .from('attachments')
    .insert({
      message_id: messageId,
      name: file.name,
      type: file.type,
      size: file.size,
      storage_path: path,
      status: 'ready'
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * 获取消息的所有附件
 */
export async function getAttachments(messageId: string): Promise<FileAttachment[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('message_id', messageId)

  if (error) throw error
  return data || []
}

/**
 * 删除附件
 */
export async function deleteAttachment(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase 未配置')

  // 1. 获取附件信息
  const { data: attachment } = await supabase
    .from('attachments')
    .select('storage_path')
    .eq('id', id)
    .single()

  if (attachment) {
    // 2. 删除 Storage 文件
    await supabase.storage
      .from('solidify-files')
      .remove([attachment.storage_path])
  }

  // 3. 删除数据库记录
  const { error } = await supabase
    .from('attachments')
    .delete()
    .eq('id', id)

  if (error) throw error
}
