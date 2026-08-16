import { describe, expect, it } from 'vitest'
import { createPptdDegradationReport, formatPptdDegradationReport } from './report'

describe('PPTD degradation report', () => {
  it('creates a visible report instead of silently discarding fallbacks', () => {
    const report = createPptdDegradationReport('Demo', ['第 2 页 chart: sankey exported as a static image'])
    expect(report.count).toBe(1)
    expect(formatPptdDegradationReport(report)).toContain('有 1 处降级')
    expect(formatPptdDegradationReport(report)).toContain('sankey')
  })

  it('clearly reports the no-degradation case', () => {
    expect(createPptdDegradationReport('Demo', []).summary).toContain('未发生降级')
  })
})
