/**
 * 文件内容提取工具
 * 支持文本、PDF、图片等格式
 */
import type JSZip from 'jszip'

export interface FileExtractionLimits {
  maxCharacters: number
  maxPdfPages: number
  maxArchiveEntries: number
  maxExpandedBytes: number
}

export interface FileExtractionResult {
  status: 'parsed' | 'unsupported' | 'truncated' | 'failed'
  content: string
  format: string
  parser: string
  parserVersion: string
  warnings: string[]
  totalCharacters: number
  externalMethods?: ('image_ocr' | 'pdf_ocr')[]
  reasonCode?: string
  pageCount?: number
  parsedPages?: number
}

const DEFAULT_EXTRACTION_LIMITS: FileExtractionLimits = {
  maxCharacters: 200_000,
  maxPdfPages: 100,
  maxArchiveEntries: 2_000,
  maxExpandedBytes: 128 * 1024 * 1024,
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'log',
])

/**
 * 提取文件文本内容
 */
export async function extractText(file: File): Promise<string> {
  const result = await extractTextResult(file)
  if (result.status === 'failed') return `[文件: ${file.name}，提取失败: ${result.warnings.join('；')}]`
  if (result.status === 'unsupported') return `[文件: ${file.name}，类型: ${file.type || '未知'}]`
  return result.content
}

/** Extract text with explicit status and hard resource budgets. */
export async function extractTextResult(
  file: File,
  limits: Partial<FileExtractionLimits> = {},
): Promise<FileExtractionResult> {
  const resolved = { ...DEFAULT_EXTRACTION_LIMITS, ...limits }
  const format = file.name.toLowerCase().split('.').pop() ?? 'unknown'
  const parsed = (content: string, parser: string, warnings: string[] = []): FileExtractionResult => {
    const totalCharacters = content.length
    const truncated = totalCharacters > resolved.maxCharacters
    return {
      status: truncated ? 'truncated' : 'parsed',
      content: truncated ? content.slice(0, resolved.maxCharacters) : content,
      format,
      parser,
      parserVersion: 'folder-task-v3',
      warnings: truncated
        ? [...warnings, `文本超过 ${resolved.maxCharacters} 字符，已截断`]
        : warnings,
      totalCharacters,
    }
  }

  // 文本文件直接读取。扩展名也必须参与判断，因为浏览器常把本地
  // JSON/XML/日志文件标记为 application/* 或 octet-stream。
  if (file.type.startsWith('text/') || TEXT_EXTENSIONS.has(format)) {
    return parsed(await file.text(), 'browser-text')
  }

  // PDF 提取
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    try {
      const extracted = await extractPdfText(file, resolved)
      const result = parsed(extracted.content, 'pdfjs', extracted.warnings)
      if (extracted.parsedPages < extracted.pageCount) result.status = 'truncated'
      return { ...result, pageCount: extracted.pageCount, parsedPages: extracted.parsedPages,
        ...(extracted.emptyTextPages.length && extracted.parsedPages === extracted.pageCount
          ? { externalMethods: ['pdf_ocr' as const], reasonCode: 'pdf_pages_without_text',
            warnings: [...result.warnings, `第 ${extracted.emptyTextPages.join('、')} 页没有可提取文本，可能是扫描页或空白页`] }
          : {}),
      }
    } catch (error) {
      console.error('PDF 提取失败:', error)
      return failedExtraction(format, 'pdfjs', error)
    }
  }

  // 图片文件（暂不支持 OCR）
  if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg'].includes(format)) {
    return { status: 'unsupported', content: '', format, parser: 'none', parserVersion: 'folder-task-v3', warnings: ['图片需要视觉或 OCR 解析器'], totalCharacters: 0,
      ...(['png', 'jpg', 'jpeg'].includes(format) ? { externalMethods: ['image_ocr' as const], reasonCode: 'image_requires_ocr' } : {}),
    }
  }

  // DOCX 文件
  if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx')) {
    try {
      await preflightZip(file, resolved)
      return parsed(await extractDocxText(file), 'mammoth')
    } catch (error) {
      console.error('DOCX 提取失败:', error)
      return failedExtraction(format, 'mammoth', error)
    }
  }

  // XLSX files are ZIP packages. Extract workbook cell values locally so
  // FolderTask can process spreadsheets without uploading them or requiring a
  // second parsing service.
  if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.name.toLowerCase().endsWith('.xlsx')) {
    try {
      return parsed(await extractXlsxText(file, resolved), 'openxml-xlsx')
    } catch (error) {
      console.error('XLSX 提取失败:', error)
      return failedExtraction(format, 'openxml-xlsx', error)
    }
  }

  // 其他格式
  return { status: 'unsupported', content: '', format, parser: 'none', parserVersion: 'folder-task-v3', warnings: [`不支持的文件类型：${file.type || format}`], totalCharacters: 0 }
}

function failedExtraction(format: string, parser: string, error: unknown): FileExtractionResult {
  return {
    status: 'failed',
    content: '',
    format,
    parser,
    parserVersion: 'folder-task-v3',
    warnings: [error instanceof Error ? error.message : String(error)],
    totalCharacters: 0,
    reasonCode: error instanceof Error && error.name === 'PasswordException' ? 'encrypted' : 'parse_failed',
  }
}

/** Infer a useful browser MIME type from a local filename. */
export function inferFileMimeType(name: string): string {
  const extension = name.toLowerCase().split('.').pop()
  const types: Record<string, string> = {
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    html: 'text/html',
    json: 'application/json',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xml: 'application/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}

async function extractXlsxText(file: File, limits: FileExtractionLimits): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  validateZipBudget(zip, limits)
  const sharedStrings = await readSharedStrings(zip)
  const workbook = await readWorkbookSheets(zip)
  const sections: string[] = []
  let extractedCharacters = 0

  for (const sheet of workbook) {
    const entry = zip.file(sheet.path)
    if (!entry) continue
    const xml = parseXml(await entry.async('string'))
    const rows: string[] = []
    for (const row of xml.querySelectorAll('sheetData > row')) {
      const value = xlsxRowValue(row, sharedStrings)
      if (value) {
        rows.push(value)
        extractedCharacters += value.length + 1
      }
      if (extractedCharacters > limits.maxCharacters) break
    }
    const section = `[Sheet: ${sheet.name}]\n${rows.join('\n')}`.trim()
    sections.push(section)
    extractedCharacters += sheet.name.length + 10
    if (extractedCharacters > limits.maxCharacters) break
  }

  return sections.filter(Boolean).join('\n\n') || `[Excel 文档: ${file.name}，内容为空]`
}

async function preflightZip(file: File, limits: FileExtractionLimits): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  validateZipBudget(zip, limits)
}

function validateZipBudget(zip: JSZip, limits: FileExtractionLimits): void {
  const entries = Object.values(zip.files)
  if (entries.length > limits.maxArchiveEntries) throw new Error(`压缩包条目数超过限制 ${limits.maxArchiveEntries}`)
  let expandedBytes = 0
  for (const entry of entries) {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
    const uncompressedSize = data?.uncompressedSize
    if (!entry.dir && !Number.isFinite(uncompressedSize)) throw new Error('无法验证压缩包展开大小')
    expandedBytes += uncompressedSize ?? 0
    if (expandedBytes > limits.maxExpandedBytes) throw new Error(`压缩包展开大小超过限制 ${limits.maxExpandedBytes} 字节`)
  }
}

function xlsxRowValue(row: Element, sharedStrings: readonly string[]): string {
  const values: string[] = []
  let nextColumn = 0
  for (const cell of row.querySelectorAll(':scope > c')) {
    const reference = cell.getAttribute('r')
    const referencedColumn = reference ? xlsxColumnIndex(reference) : undefined
    const column = referencedColumn ?? nextColumn
    values[column] = xlsxCellValue(cell, sharedStrings)
    nextColumn = column + 1
  }
  return Array.from({ length: values.length }, (_, index) => values[index] ?? '')
    .join('\t')
    .trimEnd()
}

function xlsxColumnIndex(reference: string): number | undefined {
  const letters = reference.match(/^[A-Za-z]+/)?.[0]
  if (!letters) return undefined
  let value = 0
  for (const letter of letters.toUpperCase()) {
    value = value * 26 + letter.charCodeAt(0) - 64
  }
  return value - 1
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const entry = zip.file('xl/sharedStrings.xml')
  if (!entry) return []
  const xml = parseXml(await entry.async('string'))
  return [...xml.querySelectorAll('sst > si')].map((item) =>
    [...item.querySelectorAll('t')].map((node) => node.textContent ?? '').join(''),
  )
}

async function readWorkbookSheets(zip: JSZip): Promise<Array<{ name: string; path: string }>> {
  const workbookEntry = zip.file('xl/workbook.xml')
  const relationsEntry = zip.file('xl/_rels/workbook.xml.rels')
  if (workbookEntry && relationsEntry) {
    const workbook = parseXml(await workbookEntry.async('string'))
    const relations = parseXml(await relationsEntry.async('string'))
    const targets = new Map(
      [...relations.querySelectorAll('Relationship')].map((relation) => [
        relation.getAttribute('Id') ?? '',
        normalizeXlsxPath(relation.getAttribute('Target') ?? ''),
      ]),
    )
    const sheets = [...workbook.querySelectorAll('sheets > sheet')]
      .map((sheet) => ({
        name: sheet.getAttribute('name') || '未命名工作表',
        path: targets.get(sheet.getAttribute('r:id') ?? sheet.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        ) ?? '') ?? '',
      }))
      .filter((sheet) => sheet.path)
    if (sheets.length > 0) return sheets
  }

  return Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort()
    .map((path, index) => ({ name: `Sheet${index + 1}`, path }))
}

function normalizeXlsxPath(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segments = `xl/${target}`.split('/')
  const normalized: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') normalized.pop()
    else normalized.push(segment)
  }
  return normalized.join('/')
}

function xlsxCellValue(cell: Element, sharedStrings: readonly string[]): string {
  const type = cell.getAttribute('t')
  if (type === 'inlineStr') {
    return [...cell.querySelectorAll('is t')].map((node) => node.textContent ?? '').join('')
  }
  const raw = cell.querySelector(':scope > v')?.textContent ?? ''
  if (type === 's') return sharedStrings[Number(raw)] ?? raw
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  return raw
}

function parseXml(source: string): XMLDocument {
  const xml = new DOMParser().parseFromString(source, 'application/xml')
  const error = xml.querySelector('parsererror')
  if (error) throw new Error(error.textContent || 'Invalid XML document')
  return xml
}

/**
 * 从 DOCX 提取文本
 */
async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  // Mammoth's browser build reads arrayBuffer while its Node build reads
  // buffer. Supplying both keeps extraction consistent in Tauri and tests.
  const input = {
    arrayBuffer,
    buffer: new Uint8Array(arrayBuffer),
  } as Parameters<typeof mammoth.extractRawText>[0]
  const result = await mammoth.extractRawText(input)
  return result.value || `[Word 文档: ${file.name}，内容为空]`
}

/**
 * 从 PDF 提取文本
 */
async function extractPdfText(file: File, limits: FileExtractionLimits): Promise<{ content: string; warnings: string[]; pageCount: number; parsedPages: number; emptyTextPages: number[] }> {
  const pdfjsLib = await import('pdfjs-dist')

  // 优先使用本地 worker（Tauri 离线可用），回退到 CDN
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const localWorkerUrl = import.meta.env.VITE_PDF_WORKER_URL
    if (localWorkerUrl) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = localWorkerUrl
    } else {
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).href
      } catch {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
      }
    }
  }

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  const textParts: string[] = []
  const emptyTextPages: number[] = []
  let extractedCharacters = 0

  // 提取每一页的文本
  const pageLimit = Math.min(pdf.numPages, limits.maxPdfPages)
  try {
  for (let i = 1; i <= pageLimit; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    const pageText = textContent.items
      // items 可能是 TextItem 或 TextMarkedContent，只有前者带 str
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
    textParts.push(pageText)
    if (!pageText.trim()) emptyTextPages.push(i)
    extractedCharacters += pageText.length + 2
    if (extractedCharacters > limits.maxCharacters) break
  }

  return {
    content: textParts.join('\n\n'),
    warnings: pdf.numPages > textParts.length ? [`PDF 共 ${pdf.numPages} 页，仅解析前 ${textParts.length} 页`] : [],
    pageCount: pdf.numPages, parsedPages: textParts.length, emptyTextPages,
  }
  } finally { await pdf.destroy() }
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 验证文件大小（默认限制 10MB）
 */
export function validateFileSize(file: File, maxSizeMB: number = 10): boolean {
  const maxBytes = maxSizeMB * 1024 * 1024
  return file.size <= maxBytes
}

/**
 * 验证文件类型
 */
export function validateFileType(file: File): boolean {
  const allowedTypes = [
    'text/',
    'application/pdf',
    'image/',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]

  const allowedExtensions = ['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.csv', '.xlsx', '.docx']

  return (
    allowedTypes.some(type => file.type.startsWith(type)) ||
    allowedExtensions.some(ext => file.name.toLowerCase().endsWith(ext))
  )
}
