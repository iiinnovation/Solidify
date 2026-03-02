import { describe, it, expect } from 'vitest'
import { parseSlidesDeck } from './slide-types'

describe('parseSlidesDeck', () => {
  it('should parse valid slides JSON', () => {
    const input = JSON.stringify({
      slides: [
        { layout: 'title', title: 'Test Title', subtitle: 'Test Subtitle' },
        { layout: 'content', title: 'Content', body: ['Point 1', 'Point 2'] },
      ],
    })

    const result = parseSlidesDeck(input)

    expect(result).not.toBeNull()
    expect(result?.slides).toHaveLength(2)
    expect(result?.slides[0].layout).toBe('title')
    expect(result?.slides[1].layout).toBe('content')
  })

  it('should strip markdown code fences', () => {
    const input = '```json\n{"slides":[{"layout":"title","title":"Test"}]}\n```'

    const result = parseSlidesDeck(input)

    expect(result).not.toBeNull()
    expect(result?.slides).toHaveLength(1)
  })

  it('should strip code fences without language', () => {
    const input = '```\n{"slides":[{"layout":"title","title":"Test"}]}\n```'

    const result = parseSlidesDeck(input)

    expect(result).not.toBeNull()
    expect(result?.slides).toHaveLength(1)
  })

  it('should return null for invalid JSON', () => {
    const input = 'not valid json'

    const result = parseSlidesDeck(input)

    expect(result).toBeNull()
  })

  it('should return null for empty slides array', () => {
    const input = JSON.stringify({ slides: [] })

    const result = parseSlidesDeck(input)

    expect(result).toBeNull()
  })

  it('should return null for missing slides property', () => {
    const input = JSON.stringify({ theme: 'default' })

    const result = parseSlidesDeck(input)

    expect(result).toBeNull()
  })

  it('should parse slides with theme', () => {
    const input = JSON.stringify({
      slides: [{ layout: 'title', title: 'Test' }],
      theme: 'dark',
    })

    const result = parseSlidesDeck(input)

    expect(result).not.toBeNull()
    expect(result?.theme).toBe('dark')
  })

  it('should handle all layout types', () => {
    const input = JSON.stringify({
      slides: [
        { layout: 'title', title: 'Title' },
        { layout: 'section', title: 'Section' },
        { layout: 'content', title: 'Content', body: ['Item'] },
        { layout: 'two-column', title: 'Two Col', left: ['L'], right: ['R'] },
        { layout: 'comparison', title: 'Compare', leftTitle: 'A', left: ['1'], rightTitle: 'B', right: ['2'] },
        { layout: 'image-text', title: 'Image', image: 'placeholder', body: ['Text'] },
        { layout: 'stats', title: 'Stats', stats: [{ label: 'Users', value: '100' }] },
        { layout: 'timeline', title: 'Timeline', items: [{ time: '2024', text: 'Event' }] },
      ],
    })

    const result = parseSlidesDeck(input)

    expect(result).not.toBeNull()
    expect(result?.slides).toHaveLength(8)
  })
})
