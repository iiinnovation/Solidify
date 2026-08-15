import type { PptdBounds, PptdSize } from './types'

export const PPTD_PX_PER_INCH = 96

export function toPptxBounds(bounds: PptdBounds): [number, number, number, number] {
  return bounds.map((value) => value / PPTD_PX_PER_INCH) as [number, number, number, number]
}

export function fromPptxBounds(bounds: readonly [number, number, number, number]): PptdBounds {
  return bounds.map((value) => value * PPTD_PX_PER_INCH) as unknown as PptdBounds
}

export function maxBoundsError(a: PptdBounds, b: PptdBounds): number {
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])))
}

export function pageInches(size: PptdSize): [number, number] {
  return [size[0] / PPTD_PX_PER_INCH, size[1] / PPTD_PX_PER_INCH]
}
