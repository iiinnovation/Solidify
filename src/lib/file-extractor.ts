/**
 * 文件内容提取工具
 * 支持文本、PDF、图片等格式
 */
import type JSZip from 'jszip'

/**
 * 提取文件文本内容
 */
export async function extractText(file: File): Promise<string> {
  // 文本文件直接读取
  if (file.type.startsWith('text/') || file.name.endsWith('.md')) {
    return await file.text()
  }

  // PDF 提取
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    try {
      return await extractPdfText(file)
    } catch (error) {
      console.error('PDF 提取失败:', error)
      return `[PDF 文件: ${file.name}，提取失败]`
    }
  }

  // 图片文件（暂不支持 OCR）
  if (file.type.startsWith('image/')) {
    return `[图片文件: ${file.name}，需要 AI 视觉分析]`
  }

  // CSV 文件
  if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
    return await file.text()
  }

  // DOCX 文件
  if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx')) {
    try {
      return await extractDocxText(file)
    } catch (error) {
      console.error('DOCX 提取失败:', error)
      return `[Word 文档: ${file.name}，提取失败]`
    }
  }

  // XLSX files are ZIP packages. Extract workbook cell values locally so
  // FolderTask can process spreadsheets without uploading them or requiring a
  // second parsing service.
  if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.name.toLowerCase().endsWith('.xlsx')) {
    try {
      return await extractXlsxText(file)
    } catch (error) {
      console.error('XLSX 提取失败:', error)
      return `[Excel 文档: ${file.name}，提取失败]`
    }
  }

  // 其他格式
  return `[文件: ${file.name}，类型: ${file.type || '未知'}]`
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
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xml: 'application/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}

async function extractXlsxText(file: File): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const sharedStrings = await readSharedStrings(zip)
  const workbook = await readWorkbookSheets(zip)
  const sections: string[] = []

  for (const sheet of workbook) {
    const entry = zip.file(sheet.path)
    if (!entry) continue
    const xml = parseXml(await entry.async('string'))
    const rows = [...xml.querySelectorAll('sheetData > row')]
      .map((row) => [...row.querySelectorAll(':scope > c')]
        .map((cell) => xlsxCellValue(cell, sharedStrings))
        .join('\t')
        .trimEnd())
      .filter(Boolean)
    sections.push(`[Sheet: ${sheet.name}]\n${rows.join('\n')}`.trim())
  }

  return sections.filter(Boolean).join('\n\n') || `[Excel 文档: ${file.name}，内容为空]`
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
async function extractPdfText(file: File): Promise<string> {
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

  // 提取每一页的文本
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    const pageText = textContent.items
      // items 可能是 TextItem 或 TextMarkedContent，只有前者带 str
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
    textParts.push(pageText)
  }

  return textParts.join('\n\n')
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
