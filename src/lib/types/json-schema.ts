/**
 * JSON Schema type definitions
 * Subset needed for tool input/output validation
 */

export interface JSONSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  enum?: unknown[]
  items?: JSONSchema
  properties?: Record<string, JSONSchema>
  required?: string[]
  additionalProperties?: boolean | JSONSchema
  default?: unknown
  examples?: unknown[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  pattern?: string
}

export type JSONSchema = JSONSchemaProperty
