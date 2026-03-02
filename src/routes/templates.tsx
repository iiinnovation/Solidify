/**
 * 模板管理页面
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TemplateList } from '@/components/templates/template-list'
import { TemplateEditorDialog } from '@/components/templates/template-editor-dialog'
import { TemplateVariableForm } from '@/components/templates/template-variable-form'
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useDuplicateTemplate,
  useIncrementTemplateUsage,
} from '@/hooks/use-templates'
import type { Template } from '@/lib/api/types'
import { builtinSkills } from '@/lib/skills'
import { useUIStore } from '@/stores/ui-store'

export function TemplatesPage() {
  const navigate = useNavigate()
  const setPendingInput = useUIStore((s) => s.setPendingInput)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [variableFormOpen, setVariableFormOpen] = useState(false)
  const [usingTemplate, setUsingTemplate] = useState<Template | null>(null)
  const [skillFilter, setSkillFilter] = useState<string>('')
  const [showPublicOnly, setShowPublicOnly] = useState(false)

  const { data: templates = [], isLoading } = useTemplates({
    skill_id: skillFilter || undefined,
    include_public: true,
  })

  const createMutation = useCreateTemplate()
  const updateMutation = useUpdateTemplate()
  const deleteMutation = useDeleteTemplate()
  const duplicateMutation = useDuplicateTemplate()
  const incrementUsageMutation = useIncrementTemplateUsage()

  const handleCreate = () => {
    setEditingTemplate(null)
    setEditorOpen(true)
  }

  const handleEdit = (template: Template) => {
    setEditingTemplate(template)
    setEditorOpen(true)
  }

  const handleSave = (data: Parameters<typeof createMutation.mutate>[0]) => {
    if (editingTemplate) {
      updateMutation.mutate(
        { id: editingTemplate.id, input: data },
        {
          onSuccess: () => {
            setEditorOpen(false)
            setEditingTemplate(null)
          },
        }
      )
    } else {
      createMutation.mutate(data, {
        onSuccess: () => {
          setEditorOpen(false)
        },
      })
    }
  }

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id)
  }

  const handleDuplicate = (id: string) => {
    duplicateMutation.mutate(id)
  }

  const handleUse = (template: Template) => {
    setUsingTemplate(template)
    setVariableFormOpen(true)
  }

  const handleSubmitVariables = (content: string) => {
    if (usingTemplate) {
      incrementUsageMutation.mutate(usingTemplate.id)
      setPendingInput(content)
      setVariableFormOpen(false)
      setUsingTemplate(null)
      navigate('/chat')
    }
  }

  const filteredTemplates = showPublicOnly
    ? templates.filter((t) => t.is_public)
    : templates

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">模板管理</h1>
            <p className="text-sm text-muted-foreground mt-1">
              创建和管理文档模板，支持变量替换
            </p>
          </div>
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-2" />
            创建模板
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <select
              value={skillFilter}
              onChange={(e) => setSkillFilter(e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="">所有技能</option>
              {builtinSkills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showPublicOnly}
              onChange={(e) => setShowPublicOnly(e.target.checked)}
              className="rounded"
            />
            仅显示公开模板
          </label>

          <div className="ml-auto text-sm text-muted-foreground">
            共 {filteredTemplates.length} 个模板
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">
            加载中...
          </div>
        ) : (
          <TemplateList
            templates={filteredTemplates}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onUse={handleUse}
          />
        )}
      </div>

      {/* Dialogs */}
      <TemplateEditorDialog
        template={editingTemplate}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false)
          setEditingTemplate(null)
        }}
        onSave={handleSave}
      />

      {usingTemplate && (
        <TemplateVariableForm
          template={usingTemplate}
          open={variableFormOpen}
          onClose={() => {
            setVariableFormOpen(false)
            setUsingTemplate(null)
          }}
          onSubmit={handleSubmitVariables}
        />
      )}
    </div>
  )
}
