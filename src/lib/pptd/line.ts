import type { PptdElement } from './types'

export type PptdLinePoint = readonly [number, number]

export interface PptdLineGeometry {
  viewBox: readonly [number, number]
  points: PptdLinePoint[]
}

/** Normalizes the permissive model-facing line syntax into a drawable polyline. */
export function pptdLineGeometry(element: PptdElement): PptdLineGeometry {
  const [, , width, height] = element.bounds
  const rawViewBox = element.viewBox
  const viewBox: [number, number] = Array.isArray(rawViewBox) && rawViewBox.length === 2
    ? [positive(rawViewBox[0], width), positive(rawViewBox[1], height)]
    : [100, 100]
  const rawPoints = (element as Record<string, unknown>).points
  const points = parsePoints(rawPoints)
  if (points.length >= 2) return { viewBox, points }
  return { viewBox, points: [[0, 0], [viewBox[0], viewBox[1]]] }
}

export function pptdAbsoluteLinePoints(element: PptdElement): PptdLinePoint[] {
  const [x, y, width, height] = element.bounds
  const geometry = pptdLineGeometry(element)
  return geometry.points.map(([px, py]) => [
    x + px / geometry.viewBox[0] * width,
    y + py / geometry.viewBox[1] * height,
  ])
}

export function pptdLineArrow(element: PptdElement, side: 'start' | 'end'): string | undefined {
  const stroke = record(element.stroke ?? element.border)
  const value = (element as Record<string, unknown>)[`${side}Arrow`] ?? stroke[`${side}Arrow`]
  if (value === true) return 'triangle'
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return ['none', 'false', ''].includes(normalized) ? undefined : normalized
}

export function pptdLineIsOrthogonal(points: readonly PptdLinePoint[]): boolean {
  return points.slice(1).every(([x, y], index) => {
    const [px, py] = points[index]
    return Math.abs(x - px) <= 1 || Math.abs(y - py) <= 1
  })
}

function parsePoints(value: unknown): PptdLinePoint[] {
  if (typeof value === 'string') {
    return value.trim().split(/\s+/).map((point) => {
      const [x, y] = point.split(',').map(Number)
      return [x, y] as const
    }).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((point): PptdLinePoint[] => {
    if (Array.isArray(point) && point.length >= 2) {
      const [x, y] = point.map(Number)
      return Number.isFinite(x) && Number.isFinite(y) ? [[x, y]] : []
    }
    if (point && typeof point === 'object') {
      const item = point as Record<string, unknown>
      const x = Number(item.x)
      const y = Number(item.y)
      return Number.isFinite(x) && Number.isFinite(y) ? [[x, y]] : []
    }
    return []
  })
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
