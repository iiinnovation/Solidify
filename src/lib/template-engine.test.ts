import { describe, it, expect } from 'vitest'
import {
  extractVariables,
  replaceVariables,
  validateVariableValues,
  getDefaultValues,
  previewTemplate,
  inferVariables,
} from './template-engine'
import type { TemplateVariable } from './api/types'

describe('extractVariables', () => {
  it('should extract variables from template', () => {
    const content = 'Hello {{name}}, welcome to {{company}}!'
    const result = extractVariables(content)

    expect(result).toEqual(['name', 'company'])
  })

  it('should handle duplicate variables', () => {
    const content = '{{name}} and {{name}} again'
    const result = extractVariables(content)

    expect(result).toEqual(['name'])
  })

  it('should return empty array for no variables', () => {
    const content = 'No variables here'
    const result = extractVariables(content)

    expect(result).toEqual([])
  })

  it('should only match word characters', () => {
    const content = '{{valid}} {{invalid-name}} {{also_valid}}'
    const result = extractVariables(content)

    expect(result).toEqual(['valid', 'also_valid'])
  })
})

describe('replaceVariables', () => {
  it('should replace variables with values', () => {
    const content = 'Hello {{name}}, welcome to {{company}}!'
    const values = { name: 'Alice', company: 'Acme Corp' }

    const result = replaceVariables(content, values)

    expect(result).toBe('Hello Alice, welcome to Acme Corp!')
  })

  it('should replace multiple occurrences', () => {
    const content = '{{name}} and {{name}} again'
    const values = { name: 'Bob' }

    const result = replaceVariables(content, values)

    expect(result).toBe('Bob and Bob again')
  })

  it('should keep variables unchanged for missing values', () => {
    const content = 'Hello {{name}}'
    const values = {}

    const result = replaceVariables(content, values)

    expect(result).toBe('Hello {{name}}')
  })

  it('should handle empty values', () => {
    const content = 'Hello {{name}}'
    const values = { name: '' }

    const result = replaceVariables(content, values)

    expect(result).toBe('Hello ')
  })
})

describe('validateVariableValues', () => {
  it('should validate required fields', () => {
    const variables: TemplateVariable[] = [
      { name: 'name', label: '姓名', type: 'text', required: true },
    ]
    const values = { name: '' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(false)
    expect(result.errors.name).toBe('姓名为必填项')
  })

  it('should pass validation for filled required fields', () => {
    const variables: TemplateVariable[] = [
      { name: 'name', label: '姓名', type: 'text', required: true },
    ]
    const values = { name: 'Alice' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual({})
  })

  it('should validate select options', () => {
    const variables: TemplateVariable[] = [
      {
        name: 'status',
        label: '状态',
        type: 'select',
        required: false,
        options: ['active', 'inactive'],
      },
    ]
    const values = { status: 'invalid' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(false)
    expect(result.errors.status).toBe('状态的值不在可选范围内')
  })

  it('should validate date format', () => {
    const variables: TemplateVariable[] = [
      { name: 'date', label: '日期', type: 'date', required: false },
    ]
    const values = { date: 'invalid-date' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(false)
    expect(result.errors.date).toBe('日期的日期格式不正确')
  })

  it('should pass validation for valid date', () => {
    const variables: TemplateVariable[] = [
      { name: 'date', label: '日期', type: 'date', required: false },
    ]
    const values = { date: '2024-01-01' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(true)
  })

  it('should allow empty optional fields', () => {
    const variables: TemplateVariable[] = [
      { name: 'optional', label: '可选', type: 'text', required: false },
    ]
    const values = { optional: '' }

    const result = validateVariableValues(variables, values)

    expect(result.valid).toBe(true)
  })
})

describe('getDefaultValues', () => {
  it('should return default values', () => {
    const variables: TemplateVariable[] = [
      { name: 'name', label: '姓名', type: 'text', required: true, default_value: 'John' },
      { name: 'age', label: '年龄', type: 'text', required: false },
    ]

    const result = getDefaultValues(variables)

    expect(result.name).toBe('John')
    expect(result.age).toBe('')
  })

  it('should use today for date type without default', () => {
    const variables: TemplateVariable[] = [
      { name: 'date', label: '日期', type: 'date', required: false },
    ]

    const result = getDefaultValues(variables)

    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('previewTemplate', () => {
  it('should preview template with valid values', () => {
    const content = 'Hello {{name}}'
    const variables: TemplateVariable[] = [
      { name: 'name', label: '姓名', type: 'text', required: true },
    ]
    const values = { name: 'Alice' }

    const result = previewTemplate(content, variables, values)

    expect(result).toBe('Hello Alice')
  })

  it('should throw error for invalid values', () => {
    const content = 'Hello {{name}}'
    const variables: TemplateVariable[] = [
      { name: 'name', label: '姓名', type: 'text', required: true },
    ]
    const values = { name: '' }

    expect(() => previewTemplate(content, variables, values)).toThrow('变量值验证失败')
  })
})

describe('inferVariables', () => {
  it('should infer variables from content', () => {
    const content = 'Hello {{name}}, your email is {{email}}'

    const result = inferVariables(content)

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('name')
    expect(result[0].type).toBe('text')
    expect(result[0].required).toBe(true)
  })

  it('should infer date type from variable name', () => {
    const content = 'Date: {{start_date}}'

    const result = inferVariables(content)

    expect(result[0].type).toBe('date')
  })

  it('should infer textarea type from variable name', () => {
    const content = 'Description: {{description}}'

    const result = inferVariables(content)

    expect(result[0].type).toBe('textarea')
  })

  it('should generate friendly labels', () => {
    const content = '{{user_name}} {{startDate}}'

    const result = inferVariables(content)

    expect(result[0].label).toBe('User Name')
    expect(result[1].label).toBe('Start Date')
  })
})
