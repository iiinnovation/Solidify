/**
 * 模板变量填写对话框
 * 用于使用模板时填写变量值
 */

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Template, TemplateVariable } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import {
  getDefaultValues,
  validateVariableValues,
  previewTemplate,
} from '@/lib/template-engine'

interface TemplateVariableFormProps {
  template: Template
  open: boolean
  onClose: () => void
  onSubmit: (content: string) => void
}

export function TemplateVariableForm({
  template,
  open,
  onClose,
  onSubmit,
}: TemplateVariableFormProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showPreview, setShowPreview] = useState(false)

  useEffect(() => {
    if (open) {
      setValues(getDefaultValues(template.variables))
      setErrors({})
      setShowPreview(false)
    }
  }, [template, open])

  const handleSubmit = () => {
    const validation = validateVariableValues(template.variables, values)

    if (!validation.valid) {
      setErrors(validation.errors)
      return
    }

    try {
      const content = previewTemplate(template.content, template.variables, values)
      onSubmit(content)
    } catch (error) {
      console.error('模板预览失败:', error)
    }
  }

  const renderVariableInput = (variable: TemplateVariable) => {
    const value = values[variable.name] || ''
    const error = errors[variable.name]

    const commonProps = {
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        setValues({ ...values, [variable.name]: e.target.value })
        if (error) {
          setErrors({ ...errors, [variable.name]: '' })
        }
      },
      placeholder: variable.placeholder || `请输入${variable.label}`,
      className: `w-full px-3 py-2 border rounded-lg ${error ? 'border-red-500' : ''}`,
    }

    switch (variable.type) {
      case 'textarea':
        return <textarea {...commonProps} rows={4} />
      case 'select':
        return (
          <select {...commonProps}>
            <option value="">请选择</option>
            {variable.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )
      case 'date':
        return <input {...commonProps} type="date" />
      default:
        return <input {...commonProps} type="text" />
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">{template.name}</h2>
            {template.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {template.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!showPreview ? (
            <div className="space-y-4">
              {template.variables.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  此模板无需填写变量
                </p>
              ) : (
                template.variables.map((variable) => (
                  <div key={variable.name}>
                    <label className="text-sm font-medium flex items-center gap-1">
                      {variable.label}
                      {variable.required && (
                        <span className="text-red-500">*</span>
                      )}
                    </label>
                    <div className="mt-1">
                      {renderVariableInput(variable)}
                      {errors[variable.name] && (
                        <p className="text-xs text-red-500 mt-1">
                          {errors[variable.name]}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="prose prose-sm max-w-none">
              <div className="bg-muted/50 rounded-lg p-4 whitespace-pre-wrap font-mono text-sm">
                {previewTemplate(template.content, template.variables, values)}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t">
          <Button
            variant="outline"
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? '返回编辑' : '预览'}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleSubmit}>使用模板</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
