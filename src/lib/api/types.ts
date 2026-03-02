/**
 * API 层共享类型定义
 * 对应 shared-contract.md 中的数据模型
 */

export interface Profile {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  role: 'admin' | 'member'
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  description: string | null
  owner_id: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

export interface Conversation {
  id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface FileAttachment {
  id: string
  message_id: string
  name: string
  type: string
  size: number
  storage_path: string
  extracted_content?: string
  status: 'uploading' | 'ready' | 'processing' | 'error'
  error_message?: string
  created_at: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  model: string | null
  attachments?: FileAttachment[]
  created_at: string
}

export interface Artifact {
  id: string
  conversation_id: string
  message_id: string
  title: string
  type: 'document' | 'slides' | 'code' | 'mermaid' | 'chart' | 'drawio'
  content: string
  version: number
  created_at: string
  updated_at: string
}

export interface KnowledgeEntry {
  id: string
  project_id: string | null
  source_type: 'conversation' | 'artifact' | 'manual'
  source_id: string | null
  title: string
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface Template {
  id: string
  owner_id: string
  project_id: string | null
  skill_id: string | null
  name: string
  description: string | null
  content: string
  variables: TemplateVariable[]
  is_public: boolean
  usage_count: number
  created_at: string
  updated_at: string
}

export interface TemplateVariable {
  name: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'date'
  default_value?: string
  required: boolean
  placeholder?: string
  options?: string[]
}
