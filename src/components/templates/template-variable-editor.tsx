/**
 * 模板变量编辑器组件
 * 用于编辑模板中的变量定义
 */

import { Plus, Trash2, GripVertical } from 'lucide-react'
import type { TemplateVariable } from '@/lib/api/types'
import { Button } from '@/components/ui/button'

interface TemplateVariableEditorProps {
  variables: TemplateVariable[]
  onChange: (variables: TemplateVariable[]) => void
}

export function TemplateVariableEditor({
  variables,
  onChange,
}: TemplateVariableEditorProps) {
  const addVariable = () => {
    const newVariable: TemplateVariable = {
      name: `variable_${variables.length + 1}`,
      label: '新变量',
      type: 'text',
      required: false,
    }
    onChange([...variables, newVariable])
  }

  const updateVariable = (index: number, updates: Partial<TemplateVariable>) => {
    const updated = [...variables]
    updated[index] = { ...updated[index], ...updates }
    onChange(updated)
  }

  const removeVariable = (index: number) => {
    onChange(variables.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">变量定义</label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addVariable}
        >
          <Plus className="h-4 w-4 mr-1" />
          添加变量
        </Button>
      </div>

      {variables.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8 border border-dashed rounded-lg">
          暂无变量，点击"添加变量"开始
        </div>
      ) : (
        <div className="space-y-2">
          {variables.map((variable, index) => (
            <div
              key={index}
              className="border rounded-lg p-3 space-y-3 bg-background"
            >
              <div className="flex items-start gap-2">
                <GripVertical className="h-5 w-5 text-muted-foreground mt-2 cursor-move" />
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      变量名
                    </label>
                    <input
                      type="text"
                      value={variable.name}
                      onChange={(e) =>
                        updateVariable(index, { name: e.target.value })
                      }
                      className="w-full px-2 py-1 text-sm border rounded"
                      placeholder="variable_name"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      显示标签
                    </label>
                    <input
                      type="text"
                      value={variable.label}
                      onChange={(e) =>
                        updateVariable(index, { label: e.target.value })
                      }
                      className="w-full px-2 py-1 text-sm border rounded"
                      placeholder="变量标签"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      类型
                    </label>
                    <select
                      value={variable.type}
                      onChange={(e) =>
                        updateVariable(index, {
                          type: e.target.value as TemplateVariable['type'],
                        })
                      }
                      className="w-full px-2 py-1 text-sm border rounded"
                    >
                      <option value="text">单行文本</option>
                      <option value="textarea">多行文本</option>
                      <option value="select">下拉选择</option>
                      <option value="date">日期</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      默认值
                    </label>
                    <input
                      type="text"
                      value={variable.default_value || ''}
                      onChange={(e) =>
                        updateVariable(index, { default_value: e.target.value })
                      }
                      className="w-full px-2 py-1 text-sm border rounded"
                      placeholder="可选"
                    />
                  </div>
                  {variable.type === 'select' && (
                    <div className="col-span-2">
                      <label className="text-xs text-muted-foreground">
                        选项（逗号分隔）
                      </label>
                      <input
                        type="text"
                        value={variable.options?.join(', ') || ''}
                        onChange={(e) =>
                          updateVariable(index, {
                            options: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        className="w-full px-2 py-1 text-sm border rounded"
                        placeholder="选项1, 选项2, 选项3"
                      />
                    </div>
                  )}
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground">
                      输入提示
                    </label>
                    <input
                      type="text"
                      value={variable.placeholder || ''}
                      onChange={(e) =>
                        updateVariable(index, { placeholder: e.target.value })
                      }
                      className="w-full px-2 py-1 text-sm border rounded"
                      placeholder="可选"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={variable.required}
                        onChange={(e) =>
                          updateVariable(index, { required: e.target.checked })
                        }
                        className="rounded"
                      />
                      必填项
                    </label>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeVariable(index)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
