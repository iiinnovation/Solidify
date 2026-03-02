import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = !!(supabaseUrl && supabaseAnonKey)

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null

// ─── Storage 辅助函数 ──────────────────────────────────────────

export async function uploadFile(
  bucket: string,
  path: string,
  file: File | Blob
): Promise<string> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: false })

  if (error) throw error

  const { data: { publicUrl } } = supabase.storage
    .from(bucket)
    .getPublicUrl(path)

  return publicUrl
}

export async function downloadFile(
  bucket: string,
  path: string
): Promise<Blob> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(path)

  if (error) throw error
  return data
}
