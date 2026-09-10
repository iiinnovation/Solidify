import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { FolderTaskItem } from '@/lib/folder-tasks/types'
import { FolderTaskSource } from './folder-task-source'

const provenance: FolderTaskItem['provenance'] = {
  relativePath: '合同.pdf', sourceHash: 'fixture-hash', size: 1, modifiedAt: 1,
  parser: 'pdf_ocr', parserVersion: 'fixture',
}

it('does not claim OCR evidence for a legacy item without a receipt', () => {
  const { container } = render(<FolderTaskSource provenance={provenance} />)
  expect(container.textContent).toBe('')
})

it('shows accuracy warnings even for a complete conversion, with read-only source details', () => {
  render(<FolderTaskSource provenance={{ ...provenance, extraction: {
    executionId: 'execution', runId: 'run', batchId: 'batch', method: 'pdf_ocr',
    parserVersion: 'poppler:fixture;tesseract:fixture', languageVersions: ['chi_sim:fixture', 'eng:fixture'],
    pages: [1, 2], complete: true, warnings: ['金额需结合原文核对'], durationMs: 10,
  } }} />)
  expect(screen.getByText('OCR 已处理 2 页。识别内容仍需核对。')).toBeTruthy()
  expect(screen.getByText('金额需结合原文核对')).toBeTruthy()
  expect(screen.getByText('fixture-hash')).toBeTruthy()
  expect(screen.getByText('1、2')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})
