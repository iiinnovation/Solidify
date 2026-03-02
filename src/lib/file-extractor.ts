/**
 * 文件内容提取工具
 * 支持文本、PDF、图片等格式
 */

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

  // 其他格式
  return `[文件: ${file.name}，类型: ${file.type || '未知'}]`
}

/**
 * 从 DOCX 提取文本
 */
async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
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
      .map((item: any) => item.str)
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
