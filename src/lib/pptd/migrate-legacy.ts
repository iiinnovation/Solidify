import type { SlidesDeck, SlideItem } from '@/lib/slide-types'
import { defaultTheme } from '@/lib/slide-themes'
import type { PptdElement, PptdPage, PptdProject, PptdTextStyle } from './types'

const SIZE = [960, 540] as const

export function legacyToPptd(deck: SlidesDeck, title = 'Migrated presentation'): PptdProject {
  const theme = {
    colors: {
      bg: defaultTheme.colors.background,
      surface: defaultTheme.colors.surface,
      text: defaultTheme.colors.text,
      muted: defaultTheme.colors.textSecondary,
      primary: defaultTheme.colors.primary,
      accent: defaultTheme.colors.accent,
    },
    textStyles: {
      title: { fontSize: 32, bold: true, color: defaultTheme.colors.primary } satisfies PptdTextStyle,
      body: { fontSize: 18, color: defaultTheme.colors.text } satisfies PptdTextStyle,
      small: { fontSize: 13, color: defaultTheme.colors.textSecondary } satisfies PptdTextStyle,
    },
  }
  const pages = deck.slides.map((slide, index) => migrateSlide(slide, theme.colors, index))
  return { version: 'v2', title, size: SIZE, theme, pages, pagePaths: pages.map((_page, index) => `pages/${String(index + 1).padStart(2, '0')}.page`), media: {} }
}

function migrateSlide(slide: SlideItem, colors: Record<string, string>, pageIndex: number): PptdPage {
  const elements: PptdElement[] = []
  const titleBounds: readonly [number, number, number, number] = slide.layout === 'title' || slide.layout === 'section' ? [80, 150, 800, 72] : [48, 32, 864, 48]
  if (slide.title) elements.push(textElement(`page-${pageIndex}-title`, slide.title, titleBounds, slide.layout === 'title' || slide.layout === 'section' ? 40 : 30, slide.layout === 'title' || slide.layout === 'section' ? '#FFFFFF' : colors.primary, slide.layout === 'title' || slide.layout === 'section' ? 'center' : 'left'))
  if (slide.layout === 'title' || slide.layout === 'section') {
    if (slide.subtitle) elements.push(textElement(`page-${pageIndex}-subtitle`, slide.subtitle, [120, 245, 720, 40], 18, '#FFFFFF', 'center'))
  } else if (slide.layout === 'content') {
    elements.push(bulletText(`page-${pageIndex}-body`, slide.body, [64, 112, 832, 360], colors.text, 18))
  } else if (slide.layout === 'two-column') {
    elements.push(bulletText(`page-${pageIndex}-left`, slide.left, [64, 112, 394, 360], colors.text, 16))
    elements.push(bulletText(`page-${pageIndex}-right`, slide.right, [502, 112, 394, 360], colors.text, 16))
  } else if (slide.layout === 'comparison') {
    elements.push(card('page-' + pageIndex + '-left-card', [64, 112, 394, 344], colors.surface))
    elements.push(card('page-' + pageIndex + '-right-card', [502, 112, 394, 344], colors.surface))
    if (slide.leftTitle) elements.push(textElement(`page-${pageIndex}-left-title`, slide.leftTitle, [88, 136, 346, 30], 18, colors.primary))
    if (slide.rightTitle) elements.push(textElement(`page-${pageIndex}-right-title`, slide.rightTitle, [526, 136, 346, 30], 18, colors.primary))
    elements.push(bulletText(`page-${pageIndex}-left`, slide.left, [88, 182, 346, 240], colors.text, 15))
    elements.push(bulletText(`page-${pageIndex}-right`, slide.right, [526, 182, 346, 240], colors.text, 15))
  } else if (slide.layout === 'image-text') {
    elements.push(card(`page-${pageIndex}-image`, [64, 112, 394, 344], colors.surface))
    elements.push(textElement(`page-${pageIndex}-image-label`, slide.image ?? '[图片占位]', [88, 260, 346, 40], 16, colors.muted, 'center'))
    elements.push(bulletText(`page-${pageIndex}-body`, slide.body, [502, 120, 394, 330], colors.text, 16))
  } else if (slide.layout === 'stats') {
    const stats = slide.stats ?? []
    const columns = Math.max(1, Math.min(4, stats.length))
    const cardWidth = (832 - (columns - 1) * 16) / columns
    stats.forEach((stat, index) => {
      const x = 64 + index * (cardWidth + 16)
      elements.push(card(`page-${pageIndex}-stat-${index}`, [x, 140, cardWidth, 180], colors.surface))
      elements.push(textElement(`page-${pageIndex}-stat-value-${index}`, stat.value, [x + 12, 184, cardWidth - 24, 54], 30, colors.accent, 'center'))
      elements.push(textElement(`page-${pageIndex}-stat-label-${index}`, stat.label, [x + 12, 252, cardWidth - 24, 28], 14, colors.muted, 'center'))
    })
  } else if (slide.layout === 'timeline') {
    const items = slide.items ?? []
    // Rows must stay shorter than their spacing: at ten or more items the old
    // fixed 36px row was taller than the gap it was given, so consecutive
    // entries overlapped and tripped the text-overlap check.
    const spacing = Math.min(72, 330 / Math.max(1, items.length))
    const rowHeight = Math.max(8, Math.min(36, spacing - 4))
    const dotSize = Math.min(14, rowHeight)
    items.forEach((item, index) => {
      const y = 120 + index * spacing
      elements.push({ elementId: `page-${pageIndex}-timeline-dot-${index}`, elementType: 'shape', bounds: [88, y + (rowHeight - dotSize) / 2, dotSize, dotSize], shapeName: 'ellipse', fill: { type: 'solid', color: colors.primary } })
      elements.push(textElement(`page-${pageIndex}-timeline-time-${index}`, item.time, [124, y, 120, rowHeight], 14, colors.accent))
      elements.push(textElement(`page-${pageIndex}-timeline-text-${index}`, item.text, [250, y, 630, rowHeight], 15, colors.text))
    })
  }
  if (slide.notes) elements.push({ elementId: `page-${pageIndex}-notes`, elementType: 'text', bounds: [48, 500, 864, 18], content: { text: slide.notes, fontSize: 9, color: colors.muted, wrap: false } })
  // The legacy renderer uses the theme primary colour as the full-bleed
  // background for title/section slides.  Keep that pairing with their white
  // title text when migrating; putting white text on the normal near-white
  // page background makes the title effectively invisible in both preview and
  // exported PPTX files.
  const backgroundColor = slide.layout === 'title' || slide.layout === 'section' ? colors.primary : colors.bg
  return { pageType: slide.layout, background: { type: 'solid', color: backgroundColor }, elements }
}

function textElement(elementId: string, text: string, bounds: readonly [number, number, number, number], fontSize: number, color: string, align: string = 'left'): PptdElement {
  return { elementId, elementType: 'text', bounds, content: { text, fontSize, color, align: [align, 'top'], wrap: true } }
}

function bulletText(elementId: string, value: string | string[] | undefined, bounds: readonly [number, number, number, number], color: string, fontSize: number): PptdElement {
  const lines = Array.isArray(value) ? value : value ? [value] : []
  const element = textElement(elementId, lines.map((line) => `• ${line}`).join('\n'), bounds, fontSize, color)
  // Preserve the line breaks that the legacy list renderer displays.  The
  // renderer otherwise defaults to normal white-space collapsing.
  element.content = { ...(element.content ?? {}), whiteSpace: 'pre-wrap' }
  return element
}

function card(elementId: string, bounds: readonly [number, number, number, number], color: string): PptdElement {
  return { elementId, elementType: 'shape', bounds, shapeName: 'roundRect', fill: { type: 'solid', color }, stroke: { color: '#E5E0DC', width: 1 } }
}
