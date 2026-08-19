import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { load as parseYaml } from 'js-yaml'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parsePptdProject } from './parse'
import { PptdRenderer } from './renderer'
import { validatePptdProject } from './validate'
import { exportPptdAsPptx } from './to-pptx'
import type { PptdProject } from './types'

const exampleRoot = resolve(process.cwd(), '../Solidify-refs/open-kimi-ppt/example/dji-pocket4')

describe.skipIf(!existsSync(exampleRoot))('open-kimi-ppt reference compatibility', () => {
  it('parses, validates, renders and exports every page in the complete reference deck', async () => {
    const manifest = readFileSync(resolve(exampleRoot, 'dji-pocket4.pptd'), 'utf8')
    const metadata = parseYaml(manifest) as { pages: string[] }
    const pages = Object.fromEntries(metadata.pages.map((pagePath) => [pagePath, readFileSync(resolve(exampleRoot, pagePath), 'utf8')]))
    const media = Object.fromEntries(readdirSync(resolve(exampleRoot, 'media')).map((file) => [`media/${file}`, new Uint8Array(readFileSync(resolve(exampleRoot, 'media', file)))]))
    const project = parsePptdProject({ manifest, pages, media })
    expect(project.pages).toHaveLength(18)
    expect(validatePptdProject(project).errors).toEqual([])
    for (const pageIndex of project.pages.keys()) {
      const view = render(<PptdRenderer project={project} pageIndex={pageIndex} />)
      expect(view.container.querySelector(`[data-pptd-page="${pageIndex}"]`)).toBeTruthy()
      view.unmount()
    }
    for (const pageIndex of [0, 1, 4, 16, 17]) {
      const pixels = await rasterizeReferencePage(project, pageIndex)
      expect(pixels.opaquePixels).toBeGreaterThan(960 * 540 * 0.2)
      expect(pixels.colorBuckets).toBeGreaterThan(8)
      expect(pixels.luminanceVariance).toBeGreaterThan(50)
    }
    const exported = await exportPptdAsPptx(project)
    expect(exported.blob.size).toBeGreaterThan(100_000)
    if (process.env.M5_EXPORT_REFERENCE === 'true') writeFileSync('/private/tmp/solidify-m5-reference.pptx', new Uint8Array(await exported.blob.arrayBuffer()))
  }, 20_000)
})

async function rasterizeReferencePage(project: PptdProject, pageIndex: number): Promise<{ opaquePixels: number; colorBuckets: number; luminanceVariance: number }> {
  const [width, height] = project.size
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const page = project.pages[pageIndex]
  const background = page.background?.color ?? project.theme.colors.bg ?? '#ffffff'
  context.fillStyle = rgba(background)
  context.fillRect(0, 0, width, height)

  for (const element of page.elements) {
    const [x, y, w, h] = element.bounds
    if (element.elementType === 'image' && typeof element.src === 'string') {
      const source = project.media[element.src]
      const image = source ? await loadImage(mediaDataUrl(source, element.src)) : undefined
      if (image) context.drawImage(image, x, y, w, h)
      continue
    }
    if (element.elementType === 'shape') {
      const fill = element.fill as Record<string, unknown> | undefined
      const stops = Array.isArray(fill?.stops) ? fill.stops : []
      context.fillStyle = rgba(fill?.color ?? (stops[0] as Record<string, unknown> | undefined)?.color ?? '#000000')
      if (element.shapeName === 'ellipse') {
        context.beginPath()
        context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        context.fill()
      } else context.fillRect(x, y, w, h)
      continue
    }
    if (element.elementType === 'line') {
      const stroke = (element.stroke ?? element.border ?? {}) as Record<string, unknown>
      context.strokeStyle = rgba(stroke.color ?? '#000000')
      context.lineWidth = typeof stroke.width === 'number' ? stroke.width : 1
      context.beginPath()
      context.moveTo(x, y)
      context.lineTo(x + w, y + h)
      context.stroke()
      continue
    }
    if (element.elementType === 'text') {
      const content = element.content ?? {}
      context.fillStyle = rgba(content.color ?? project.theme.colors.text ?? '#000000')
      context.font = `${typeof content.fontSize === 'number' ? content.fontSize : 18}px Arial`
      context.fillText(stripMarkup(typeof content.text === 'string' ? content.text : ''), x, y + (typeof content.fontSize === 'number' ? content.fontSize : 18))
    }
  }

  const data = context.getImageData(0, 0, width, height).data
  const buckets = new Set<string>()
  const luminances: number[] = []
  let opaquePixels = 0
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    if (alpha < 16) continue
    opaquePixels++
    buckets.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`)
    luminances.push(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722)
  }
  const mean = luminances.reduce((sum, value) => sum + value, 0) / Math.max(1, luminances.length)
  const variance = luminances.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, luminances.length)
  return { opaquePixels, colorBuckets: buckets.size, luminanceVariance: variance }
}

function mediaDataUrl(value: string | Uint8Array, path: string): string {
  if (typeof value === 'string') return value
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  const mime = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${Buffer.from(binary, 'binary').toString('base64')}`
}

function rgba(value: unknown): string {
  if (typeof value !== 'string') return '#000000'
  let hex = value.trim().replace(/^#/, '')
  if (!/^[\da-f]{3,8}$/i.test(hex)) return '#000000'
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((channel) => `${channel}${channel}`).join('')
  if (hex.length === 6) return `#${hex}`
  return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${parseInt(hex.slice(6, 8), 16) / 255})`
}

function stripMarkup(value: string): string { return value.replace(/<[^>]*>/g, '').slice(0, 500) }
