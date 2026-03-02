import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, TableRow, TableCell, Table, WidthType, BorderStyle } from 'docx'
import { saveFile, isTauri } from '@/lib/tauri'
import type { ArtifactType } from '@/stores/chat-store'

// ─── 导出格式定义 ──────────────────────────────────────

export interface ExportOption {
  id: string
  label: string
  extension: string
  icon: string // lucide icon name
}

const documentFormats: ExportOption[] = [
  { id: 'markdown', label: 'Markdown', extension: '.md', icon: 'FileText' },
  { id: 'html', label: 'HTML', extension: '.html', icon: 'Globe' },
  { id: 'docx', label: 'Word 文档', extension: '.docx', icon: 'FileText' },
  { id: 'pdf', label: 'PDF', extension: '.pdf', icon: 'FileText' },
]

const codeFormats: ExportOption[] = [
  { id: 'html', label: 'HTML', extension: '.html', icon: 'Code' },
]

const mermaidFormats: ExportOption[] = [
  { id: 'svg', label: 'SVG', extension: '.svg', icon: 'Image' },
  { id: 'png', label: 'PNG', extension: '.png', icon: 'Image' },
]

const chartFormats: ExportOption[] = [
  { id: 'png', label: 'PNG', extension: '.png', icon: 'Image' },
]

const slidesFormats: ExportOption[] = [
  { id: 'pptx', label: 'PowerPoint', extension: '.pptx', icon: 'Presentation' },
  { id: 'pdf', label: 'PDF', extension: '.pdf', icon: 'FileText' },
]

const drawioFormats: ExportOption[] = [
  { id: 'xml', label: 'Draw.io XML', extension: '.drawio', icon: 'FileText' },
  { id: 'svg', label: 'SVG', extension: '.svg', icon: 'Image' },
  { id: 'png', label: 'PNG', extension: '.png', icon: 'Image' },
]

export function getExportFormats(type: ArtifactType): ExportOption[] {
  switch (type) {
    case 'document':
      return documentFormats
    case 'slides':
      return slidesFormats
    case 'code':
      return codeFormats
    case 'mermaid':
      return mermaidFormats
    case 'chart':
      return chartFormats
    case 'drawio':
      return drawioFormats
    default:
      return []
  }
}

// ─── Markdown 导出 ──────────────────────────────────────

export function exportAsMarkdown(content: string): Blob {
  return new Blob([content], { type: 'text/markdown;charset=utf-8' })
}

// ─── HTML 导出 ──────────────────────────────────────

export function exportAsHtml(contentElement: HTMLElement, title: string): Blob {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; color: #333; line-height: 1.6; }
  h1, h2, h3 { color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }
</style>
</head>
<body>
${contentElement.innerHTML}
</body>
</html>`
  return new Blob([html], { type: 'text/html;charset=utf-8' })
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Word (docx) 导出 ──────────────────────────────────

export async function exportAsDocx(content: string, title: string): Promise<Blob> {
  const children = parseMarkdownToDocx(content)
  const doc = new Document({
    title,
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}

function parseMarkdownToDocx(markdown: string): (Paragraph | Table)[] {
  const lines = markdown.split('\n')
  const result: (Paragraph | Table)[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 表格检测
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|[\s:-]+\|/.test(lines[i + 1])) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      const table = parseMarkdownTable(tableLines)
      if (table) result.push(table)
      continue
    }

    // 标题
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      const level = headingMatch[1].length === 1 ? HeadingLevel.HEADING_1
        : headingMatch[1].length === 2 ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3
      result.push(new Paragraph({ heading: level, children: parseInlineFormatting(headingMatch[2]) }))
      i++
      continue
    }

    // 无序列表
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/)
    if (ulMatch) {
      const indent = Math.floor((ulMatch[1]?.length ?? 0) / 2)
      result.push(new Paragraph({
        children: parseInlineFormatting(ulMatch[2]),
        bullet: { level: indent },
      }))
      i++
      continue
    }

    // 有序列表
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/)
    if (olMatch) {
      result.push(new Paragraph({
        children: parseInlineFormatting(olMatch[2]),
        numbering: { reference: 'default-numbering', level: 0 },
      }))
      i++
      continue
    }

    // 空行
    if (line.trim() === '') {
      result.push(new Paragraph({ children: [] }))
      i++
      continue
    }

    // 普通段落
    result.push(new Paragraph({ children: parseInlineFormatting(line) }))
    i++
  }

  return result
}

function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = []
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }))
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true }))
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true }))
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true }))
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], font: 'Courier New', size: 20 }))
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }))
  }

  return runs.length > 0 ? runs : [new TextRun({ text })]
}

function parseMarkdownTable(lines: string[]): Table | null {
  if (lines.length < 3) return null

  const parseRow = (line: string) =>
    line.split('|').map(c => c.trim()).filter(c => c.length > 0)

  const headerCells = parseRow(lines[0])
  // Skip separator line (lines[1])
  const dataRows = lines.slice(2).map(parseRow)

  const rows: TableRow[] = []

  // Header row
  rows.push(new TableRow({
    tableHeader: true,
    children: headerCells.map(cell => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: cell, bold: true })],
        alignment: AlignmentType.CENTER,
      })],
      width: { size: Math.floor(100 / headerCells.length), type: WidthType.PERCENTAGE },
    })),
  }))

  // Data rows
  for (const row of dataRows) {
    rows.push(new TableRow({
      children: headerCells.map((_, idx) => new TableCell({
        children: [new Paragraph({ children: parseInlineFormatting(row[idx] ?? '') })],
        width: { size: Math.floor(100 / headerCells.length), type: WidthType.PERCENTAGE },
      })),
    }))
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
    },
  })
}

// ─── PDF 导出 ──────────────────────────────────────

export async function exportAsPdf(element: HTMLElement, title: string): Promise<Blob> {
  const html2pdf = (await import('html2pdf.js')).default
  const blob: Blob = await html2pdf()
    .set({
      margin: [10, 10, 10, 10],
      filename: `${title}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
    })
    .from(element)
    .outputPdf('blob')
  return blob
}

// ─── SVG 导出 ──────────────────────────────────────

export function exportAsSvg(svgString: string): Blob {
  return new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
}

// ─── PNG 导出（从 SVG）──────────────────────────────

export async function exportAsPng(svgString: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const img = new Image()

    img.onload = () => {
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth * scale
      canvas.height = img.naturalHeight * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Canvas context unavailable'))
        return
      }
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('PNG conversion failed'))
        },
        'image/png',
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG image load failed'))
    }

    img.src = url
  })
}

// ─── Chart PNG 导出（html2canvas）──────────────────

export async function exportChartAsPng(element: HTMLElement): Promise<Blob> {
  // html2canvas is a transitive dependency of html2pdf.js
  const html2canvas = (await import('html2canvas' as string)).default as (
    element: HTMLElement,
    options?: Record<string, unknown>,
  ) => Promise<HTMLCanvasElement>

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#FFFDF9',
  })

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('PNG conversion failed'))
      },
      'image/png',
    )
  })
}

// ─── 统一下载入口 ──────────────────────────────────

const extensionFilters: Record<string, { name: string; extensions: string[] }[]> = {
  '.md': [{ name: 'Markdown', extensions: ['md'] }],
  '.html': [{ name: 'HTML', extensions: ['html', 'htm'] }],
  '.docx': [{ name: 'Word 文档', extensions: ['docx'] }],
  '.pdf': [{ name: 'PDF', extensions: ['pdf'] }],
  '.svg': [{ name: 'SVG', extensions: ['svg'] }],
  '.png': [{ name: 'PNG', extensions: ['png'] }],
  '.pptx': [{ name: 'PowerPoint', extensions: ['pptx'] }],
  '.drawio': [{ name: 'Draw.io', extensions: ['drawio', 'xml'] }],
}

export async function downloadBlob(
  blob: Blob,
  filename: string,
): Promise<void> {
  const ext = filename.slice(filename.lastIndexOf('.'))
  const filters = extensionFilters[ext]

  if (isTauri) {
    await saveFile(blob, filename, filters)
    return
  }

  // Web 端用 file-saver
  const { saveAs } = await import('file-saver')
  saveAs(blob, filename)
}
