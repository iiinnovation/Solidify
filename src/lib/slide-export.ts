import PptxGenJS from 'pptxgenjs'
import type { SlidesDeck, SlideItem } from '@/lib/slide-types'
import type { SlideTheme } from '@/lib/slide-themes'

/** 将 string | string[] 统一为 string[] */
function toArray(v: string | string[] | undefined): string[] {
  if (!v) return []
  return Array.isArray(v) ? v : [v]
}

/** 十六进制颜色去掉 # 前缀（pptxgenjs 要求） */
function hex(color: string): string {
  return color.replace(/^#/, '')
}

export async function exportAsPptx(
  deck: SlidesDeck,
  theme: SlideTheme,
  title: string,
): Promise<Blob> {
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_16x9'
  pres.title = title

  for (const item of deck.slides) {
    const slide = pres.addSlide()
    renderSlide(slide, item, theme, pres)
  }

  return pres.write({ outputType: 'blob' }) as Promise<Blob>
}

function renderSlide(slide: PptxGenJS.Slide, item: SlideItem, theme: SlideTheme, pres: PptxGenJS) {
  const bg = hex(theme.colors.background)
  const primary = hex(theme.colors.primary)
  const text = hex(theme.colors.text)
  const textSec = hex(theme.colors.textSecondary)
  const surface = hex(theme.colors.surface)
  const accent = hex(theme.colors.accent)
  const headingFont = theme.fonts.heading.split(',')[0].replace(/['"]/g, '').trim()
  const bodyFont = theme.fonts.body.split(',')[0].replace(/['"]/g, '').trim()

  switch (item.layout) {
    case 'title':
    case 'section': {
      slide.background = { color: primary }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 1.5, w: 8.4, h: 1.5,
        fontSize: 36, fontFace: headingFont, color: 'FFFFFF',
        bold: true, align: 'center', valign: 'bottom',
      })
      if (item.subtitle) {
        slide.addText(item.subtitle, {
          x: 1.5, y: 3.2, w: 7, h: 0.8,
          fontSize: 18, fontFace: bodyFont, color: 'FFFFFFCC',
          align: 'center', valign: 'top',
        })
      }
      break
    }
    case 'content': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      const bullets = toArray(item.body)
      if (bullets.length > 0) {
        slide.addText(
          bullets.map((b) => ({ text: b, options: { bullet: true, indentLevel: 0 } })),
          { x: 0.8, y: 1.3, w: 8.4, h: 3.7, fontSize: 16, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.4 },
        )
      }
      break
    }

    case 'two-column': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      const leftItems = toArray(item.left)
      const rightItems = toArray(item.right)
      if (leftItems.length > 0) {
        slide.addText(
          leftItems.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 0.8, y: 1.3, w: 4, h: 3.7, fontSize: 14, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.4 },
        )
      }
      if (rightItems.length > 0) {
        slide.addText(
          rightItems.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 5.2, y: 1.3, w: 4, h: 3.7, fontSize: 14, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.4 },
        )
      }
      break
    }

    case 'comparison': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      // Left card
      slide.addShape(pres.ShapeType.roundRect, { x: 0.8, y: 1.3, w: 4, h: 3.5, fill: { color: surface }, rectRadius: 0.1 } as never)
      slide.addText(item.leftTitle ?? '', {
        x: 1.0, y: 1.4, w: 3.6, h: 0.5,
        fontSize: 16, fontFace: headingFont, color: primary, bold: true,
      })
      const cmpLeft = toArray(item.left)
      if (cmpLeft.length > 0) {
        slide.addText(
          cmpLeft.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 1.0, y: 2.0, w: 3.6, h: 2.6, fontSize: 13, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.3 },
        )
      }
      // Right card
      slide.addShape(pres.ShapeType.roundRect, { x: 5.2, y: 1.3, w: 4, h: 3.5, fill: { color: surface }, rectRadius: 0.1 } as never)
      slide.addText(item.rightTitle ?? '', {
        x: 5.4, y: 1.4, w: 3.6, h: 0.5,
        fontSize: 16, fontFace: headingFont, color: primary, bold: true,
      })
      const cmpRight = toArray(item.right)
      if (cmpRight.length > 0) {
        slide.addText(
          cmpRight.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 5.4, y: 2.0, w: 3.6, h: 2.6, fontSize: 13, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.3 },
        )
      }
      break
    }

    case 'image-text': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      // Image placeholder
      slide.addShape(pres.ShapeType.roundRect, { x: 0.8, y: 1.3, w: 4.2, h: 3.5, fill: { color: surface }, rectRadius: 0.1 } as never)
      slide.addText(item.image ?? '[图片]', {
        x: 0.8, y: 1.3, w: 4.2, h: 3.5,
        fontSize: 14, fontFace: bodyFont, color: textSec, align: 'center', valign: 'middle',
      })
      const imgBody = toArray(item.body)
      if (imgBody.length > 0) {
        slide.addText(
          imgBody.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 5.4, y: 1.3, w: 3.8, h: 3.5, fontSize: 14, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.4 },
        )
      }
      break
    }

    case 'stats': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      const stats = item.stats ?? []
      const cols = Math.min(stats.length, 4)
      const cardW = cols > 0 ? (8.4 / cols) - 0.2 : 2
      stats.forEach((s, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const x = 0.8 + col * (cardW + 0.2)
        const y = 1.4 + row * 1.8
        slide.addShape(pres.ShapeType.roundRect, { x, y, w: cardW, h: 1.5, fill: { color: surface }, rectRadius: 0.1 } as never)
        slide.addText(s.value, {
          x, y: y + 0.15, w: cardW, h: 0.8,
          fontSize: 28, fontFace: headingFont, color: accent, bold: true, align: 'center',
        })
        slide.addText(s.label, {
          x, y: y + 0.85, w: cardW, h: 0.5,
          fontSize: 12, fontFace: bodyFont, color: textSec, align: 'center',
        })
      })
      break
    }

    case 'timeline': {
      slide.background = { color: bg }
      slide.addText(item.title ?? '', {
        x: 0.8, y: 0.4, w: 8.4, h: 0.7,
        fontSize: 24, fontFace: headingFont, color: primary, bold: true,
      })
      const timeItems = item.items ?? []
      const stepH = Math.min(0.7, 3.5 / Math.max(timeItems.length, 1))
      timeItems.forEach((t, i) => {
        const y = 1.4 + i * stepH
        slide.addShape(pres.ShapeType.ellipse, { x: 1.5, y: y + 0.1, w: 0.2, h: 0.2, fill: { color: primary } } as never)
        slide.addText(t.time, {
          x: 0.5, y, w: 0.9, h: stepH,
          fontSize: 11, fontFace: bodyFont, color: accent, bold: true, align: 'right', valign: 'top',
        })
        slide.addText(t.text, {
          x: 2.0, y, w: 7, h: stepH,
          fontSize: 13, fontFace: bodyFont, color: text, valign: 'top',
        })
      })
      break
    }

    default: {
      // Fallback: render as content
      slide.background = { color: bg }
      if (item.title) {
        slide.addText(item.title, {
          x: 0.8, y: 0.4, w: 8.4, h: 0.7,
          fontSize: 24, fontFace: headingFont, color: primary, bold: true,
        })
      }
      const fallbackBody = toArray(item.body)
      if (fallbackBody.length > 0) {
        slide.addText(
          fallbackBody.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 0.8, y: 1.3, w: 8.4, h: 3.7, fontSize: 16, fontFace: bodyFont, color: text, lineSpacingMultiple: 1.4 },
        )
      }
      break
    }
  }

  if (item.notes) {
    slide.addNotes(item.notes)
  }
}
