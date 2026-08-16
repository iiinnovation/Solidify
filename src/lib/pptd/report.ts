export interface PptdDegradationReport {
  title: string
  count: number
  degradations: string[]
  summary: string
}

export function createPptdDegradationReport(title: string, degradations: readonly string[]): PptdDegradationReport {
  const entries = [...degradations]
  const summary = entries.length === 0
    ? `${title} 导出完成，未发生降级。`
    : `${title} 导出完成，有 ${entries.length} 处降级：\n${entries.map((item) => `  · ${item}`).join('\n')}`
  return { title, count: entries.length, degradations: entries, summary }
}

export function formatPptdDegradationReport(report: PptdDegradationReport): string {
  return report.summary
}
