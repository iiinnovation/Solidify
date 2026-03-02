/**
 * 模板创建/编辑对话框
 */

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Template, TemplateVariable } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { TemplateVariableEditor } from './template-variable-editor'
import { inferVariables } from '@/lib/template-engine'
import { builtinSkills } from '@/lib/skills'

interface TemplateEditorDialogProps {
  template?: Template | null
  open: boolean
  onClose: () => void
  onSave: (data: {
    name: string
    description: string
    content: string
    variables: TemplateVariable[]
    skill_id?: string
    is_public: boolean
  }) => void
}

export function TemplateEditorDialog({
  template,
  open,
  onClose,
  onSave,
}: TemplateEditorDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [variables, setVariables] = useState<TemplateVariable[]>([])
  const [skillId, setSkillId] = useState<string>('')
  const [isPublic, setIsPublic] = useState(false)

  useEffect(() => {
    if (template) {
      setName(template.name)
      setDescription(template.description || '')
      setContent(template.content)
      setVariables(template.variables)
      setSkillId(template.skill_id || '')
      setIsPublic(template.is_public)
    } else {
      setName('')
      setDescription('')
      setContent('')
      setVariables([])
      setSkillId('')
      setIsPublic(false)
    }
  }, [template, open])

  const handleInferVariables = () => {
    const inferred = inferVariables(content)
    setVariables(inferred)
  }

  const handleSave = () => {
    if (!name.trim() || !content.trim()) {
      return
    }

    onSave({
      name: name.trim(),
      description: description.trim(),
      content: content.trim(),
      variables,
      skill_id: skillId || undefined,
      is_public: isPublic,
    })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">
            {template ? '编辑模板' : '创建模板'}
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* 基本信息 */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">模板名称</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg mt-1"
                placeholder="输入模板名称"
              />
            </div>

            <div>
              <label className="text-sm font-medium">描述</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg mt-1"
                placeholder="简要描述模板用途（可选）"
              />
            </div>

            <div>
              <label className="text-sm font-medium">关联技能</label>
              <select
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg mt-1"
              >
                <option value="">通用模板</option>
                {builtinSkills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 模板内容 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">模板内容</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleInferVariables}
              >
                自动识别变量
              </Button>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm min-h-[200px]"
              placeholder="输入模板内容，使用 {{variable_name}} 定义变量"
            />
            <p className="text-xs text-muted-foreground mt-1">
              使用 {`{{变量名}}`} 语法定义变量，例如：{`{{project_name}}`}、
              {`{{customer_name}}`}
            </p>
          </div>

          {/* 变量定义 */}
          <TemplateVariableEditor
            variables={variables}
            onChange={setVariables}
          />

          {/* 公开选项 */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="rounded"
              />
              公开模板（团队成员可见）
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !content.trim()}
          >
            {template ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}
