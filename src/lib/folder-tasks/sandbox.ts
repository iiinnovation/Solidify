export type SandboxExtractMethod = 'image_ocr' | 'pdf_ocr'

export interface SandboxDocumentProgress {
  executionId: string
  taskId: string
  runId: string
  relativePath: string
  method: SandboxExtractMethod
  phase: 'preparing' | 'running' | 'stopping' | 'finished'
  completedPages: number
  totalPages: number | null
}

export interface SandboxMethodCapability {
  method: SandboxExtractMethod
  available: boolean
  reasonCode: string | null
  reason: string | null
}

/** Task/run/call identity is injected by runtime code, never a model parameter. */
export interface SandboxExtractionRequest {
  taskId: string
  runId: string
  batchToken: string
  callId: string
  relativePath: string
  method: SandboxExtractMethod
}

export interface SandboxExtractedDocument {
  executionId: string
  relativePath: string
  sourceHash: string
  method: SandboxExtractMethod
  parserVersion: string
  languageVersions: string[]
  pages: { page: number; text: string }[]
  complete: boolean
  warnings: string[]
  durationMs: number
}
