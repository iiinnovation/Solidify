export type PptdSize = readonly [number, number]

export interface PptdTextStyle {
  fontSize?: number
  fontFamily?: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  lineHeight?: number
  lineHeightPx?: number
  letterSpacing?: number
  marginTop?: number
  [key: string]: unknown
}

export interface PptdTheme {
  colors: Record<string, string>
  textStyles: Record<string, PptdTextStyle>
  [key: string]: unknown
}

export type PptdBounds = readonly [number, number, number, number]

export interface PptdElement {
  elementId: string
  elementType: 'text' | 'shape' | 'image' | 'line' | 'icon' | 'table' | 'chart'
  bounds: PptdBounds
  content?: Record<string, unknown>
  shapeName?: string
  fill?: Record<string, unknown>
  stroke?: Record<string, unknown>
  src?: string
  fit?: Record<string, unknown>
  points?: unknown[]
  [key: string]: unknown
}

export interface PptdPage {
  pageType?: string
  background?: Record<string, unknown>
  elements: PptdElement[]
  [key: string]: unknown
}

export interface PptdProject {
  version: string
  title: string
  size: PptdSize
  theme: PptdTheme
  pages: PptdPage[]
  pagePaths: string[]
  media: Record<string, string | Uint8Array>
  source?: {
    manifestPath?: string
  }
}

export interface PptdFiles {
  manifest: string
  pages: Record<string, string>
  media?: Record<string, string | Uint8Array>
  manifestPath?: string
}

export interface PptdDiagnostic {
  path: string
  message: string
  severity: 'error' | 'warning'
  code?: string
}

export interface PptdValidationResult {
  errors: PptdDiagnostic[]
  warnings: PptdDiagnostic[]
  valid: boolean
}
