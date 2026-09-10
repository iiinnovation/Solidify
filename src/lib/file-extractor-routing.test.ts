import { beforeEach, describe, expect, it, vi } from 'vitest'
const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), getPage: vi.fn(), destroy: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: 'local-worker' }, getDocument: pdf.getDocument }))
import { extractTextResult, inferFileMimeType } from './file-extractor'

function pages(text: string[]) {
  pdf.getPage.mockImplementation(async (page: number) => ({ getTextContent: async () => ({ items: [{ str: text[page - 1] }] }) }))
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: text.length, getPage: pdf.getPage, destroy: pdf.destroy }) })
}
const file = () => new File(['%PDF-fixture'], 'scan.pdf', { type: 'application/pdf' })

describe('external parser routing', () => {
  beforeEach(() => { vi.resetAllMocks(); pdf.destroy.mockResolvedValue(undefined) })

  it('advertises only PNG and JPEG OCR, not arbitrary image formats', async () => {
    for (const name of ['scan.png', 'scan.jpg', 'scan.jpeg']) {
      expect(inferFileMimeType(name)).toMatch(/^image\//)
      await expect(extractTextResult(new File(['fixture'], name))).resolves.toMatchObject({ externalMethods: ['image_ocr'], reasonCode: 'image_requires_ocr' })
    }
    expect((await extractTextResult(new File(['fixture'], 'animation.gif', { type: 'image/gif' }))).externalMethods).toBeUndefined()
  })

  it('routes a fully inspected PDF with textless pages to OCR and frees the parser', async () => {
    pages(['normal text', ''])
    const result = await extractTextResult(file())
    expect(result).toMatchObject({ externalMethods: ['pdf_ocr'], pageCount: 2, parsedPages: 2, reasonCode: 'pdf_pages_without_text' })
    expect(result.warnings.join('')).toContain('2')
    expect(pdf.destroy).toHaveBeenCalledOnce()
  })

  it('does not use OCR to bypass truncation or reroute ordinary text PDFs', async () => {
    pages(['first', 'second'])
    expect((await extractTextResult(file())).externalMethods).toBeUndefined()
    pages(['', 'second'])
    const limited = await extractTextResult(file(), { maxPdfPages: 1 })
    expect(limited.status).toBe('truncated')
    expect(limited.externalMethods).toBeUndefined()
  })

  it('keeps encrypted failures distinct and does not route unknown failures to OCR', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('Password required'); error.name = 'PasswordException'
      pdf.getDocument.mockReturnValue({ promise: Promise.reject(error) })
      const result = await extractTextResult(file())
      expect(result).toMatchObject({ status: 'failed', reasonCode: 'encrypted' })
      expect(result.externalMethods).toBeUndefined()
      pages(['hello'])
      pdf.getPage.mockRejectedValue(new Error('damaged page'))
      expect(await extractTextResult(file())).toMatchObject({ status: 'failed', reasonCode: 'parse_failed' })
      expect(pdf.destroy).toHaveBeenCalledOnce()
    } finally { log.mockRestore() }
  })
})
