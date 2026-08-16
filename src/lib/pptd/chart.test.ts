import { describe, expect, it } from 'vitest'
import { chartPptxData, chartToSvg, getPptdChartSpec, isImagePptdChartType, isNativePptdChartType, PPTD_IMAGE_CHART_TYPES, PPTD_NATIVE_CHART_TYPES } from './chart'
import type { PptdElement } from './types'

function chart(chartType: string): PptdElement {
  return { elementId: chartType, elementType: 'chart', bounds: [0, 0, 320, 180], chartType, data: [{ name: 'A', value: 2 }, { name: 'B', value: 5 }] }
}

describe('PPTD chart support', () => {
  it('covers all native and image-degraded chart families', () => {
    expect(PPTD_NATIVE_CHART_TYPES).toHaveLength(8)
    expect(PPTD_IMAGE_CHART_TYPES).toHaveLength(6)
    for (const type of PPTD_NATIVE_CHART_TYPES) expect(isNativePptdChartType(type)).toBe(true)
    for (const type of PPTD_IMAGE_CHART_TYPES) expect(isImagePptdChartType(type)).toBe(true)
  })

  it('uses one deterministic SVG preview model for native and image chart types', () => {
    const spec = getPptdChartSpec(chart('sankey'))
    const svg = chartToSvg(spec, 320, 180)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<path')
    expect(chartPptxData(getPptdChartSpec(chart('bar')))[0]?.values).toEqual([2, 5])
  })
})
