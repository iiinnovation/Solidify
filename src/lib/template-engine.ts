/**
 * 模板变量替换引擎
 * 支持 {{variable}} 语法
 */

import type { TemplateVariable } from './api/types'

/**
 * 从模板内容中提取所有变量
 * @param content 模板内容
 * @returns 变量名数组
 */
export function extractVariables(content: string): string[] {
  const regex = /\{\{(\w+)\}\}/g
  const matches = content.matchAll(regex)
  const variables = new Set<string>()

  for (const match of matches) {
    variables.add(match[1])
  }

  return Array.from(variables)
}

/**
 * 替换模板中的变量
 * @param content 模板内容
 * @param values 变量值映射
 * @returns 替换后的内容
 */
export function replaceVariables(
  content: string,
  values: Record<string, string>
): string {
  let result = content

  // 替换所有 {{variable}} 为对应的值
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
    result = result.replace(regex, value || '')
  }

  return result
}

/**
 * 验证变量值
 * @param variables 变量定义
 * @param values 变量值
 * @returns 验证结果
 */
export function validateVariableValues(
  variables: TemplateVariable[],
  values: Record<string, string>
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}

  for (const variable of variables) {
    const value = values[variable.name]

    // 检查必填项
    if (variable.required && (!value || value.trim() === '')) {
      errors[variable.name] = `${variable.label}为必填项`
      continue
    }

    // 检查选项值
    if (variable.type === 'select' && variable.options && value) {
      if (!variable.options.includes(value)) {
        errors[variable.name] = `${variable.label}的值不在可选范围内`
      }
    }

    // 检查日期格式
    if (variable.type === 'date' && value) {
      const date = new Date(value)
      if (isNaN(date.getTime())) {
        errors[variable.name] = `${variable.label}的日期格式不正确`
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}

/**
 * 获取变量的默认值
 * @param variables 变量定义
 * @returns 默认值映射
 */
export function getDefaultValues(
  variables: TemplateVariable[]
): Record<string, string> {
  const values: Record<string, string> = {}

  for (const variable of variables) {
    if (variable.default_value) {
      values[variable.name] = variable.default_value
    } else if (variable.type === 'date') {
      // 日期类型默认为今天
      values[variable.name] = new Date().toISOString().split('T')[0]
    } else {
      values[variable.name] = ''
    }
  }

  return values
}

/**
 * 预览模板（替换变量并返回预览内容）
 * @param content 模板内容
 * @param variables 变量定义
 * @param values 变量值
 * @returns 预览内容
 */
export function previewTemplate(
  content: string,
  variables: TemplateVariable[],
  values: Record<string, string>
): string {
  // 先验证
  const validation = validateVariableValues(variables, values)
  if (!validation.valid) {
    throw new Error('变量值验证失败')
  }

  // 替换变量
  return replaceVariables(content, values)
}

/**
 * 从内容中智能推断变量定义
 * @param content 模板内容
 * @returns 推断的变量定义
 */
export function inferVariables(content: string): TemplateVariable[] {
  const variableNames = extractVariables(content)

  return variableNames.map((name) => {
    // 根据变量名推断类型和标签
    let type: TemplateVariable['type'] = 'text'
    let label = name

    // 推断类型
    if (name.includes('date') || name.includes('time')) {
      type = 'date'
    } else if (
      name.includes('description') ||
      name.includes('content') ||
      name.includes('detail')
    ) {
      type = 'textarea'
    }

    // 生成友好的标签（驼峰转中文）
    label = name
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')

    return {
      name,
      label,
      type,
      required: true,
      placeholder: `请输入${label}`,
    }
  })
}
