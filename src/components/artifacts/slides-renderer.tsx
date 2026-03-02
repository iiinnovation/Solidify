import { useState, useMemo, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseSlidesDeck, type SlideItem } from '@/lib/slide-types'
import { defaultTheme, type SlideTheme } from '@/lib/slide-themes'
import { ScrollArea } from '@/components/ui/scroll-area'

interface SlidesRendererProps {
  content: string
  streaming?: boolean
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return []
  return Array.isArray(v) ? v : [v]
}

// ─── Layout Components ──────────────────────────────────

function TitleSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-12" style={{ background: theme.colors.primary }}>
      <h1 className="text-4xl font-bold text-white text-center leading-tight max-w-[80%]">{slide.title}</h1>
      {slide.subtitle && (
        <p className="mt-4 text-lg text-white/75 text-center max-w-[70%]">{slide.subtitle}</p>
      )}
    </div>
  )
}

function SectionSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-12" style={{ background: theme.colors.primary }}>
      <h1 className="text-4xl font-bold text-white text-center leading-tight max-w-[80%]">{slide.title}</h1>
      {slide.subtitle && (
        <p className="mt-4 text-lg text-white/75 text-center max-w-[70%]">{slide.subtitle}</p>
      )}
    </div>
  )
}

function ContentSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const bullets = toArray(slide.body)
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <ul className="flex-1 space-y-2 overflow-hidden">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-3 text-base" style={{ color: theme.colors.text }}>
            <span className="mt-2 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TwoColumnSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const left = toArray(slide.left)
  const right = toArray(slide.right)
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
        <ul className="space-y-2 overflow-hidden">
          {left.map((b, i) => (
            <li key={i} className="flex items-start gap-3 text-sm" style={{ color: theme.colors.text }}>
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />
              {b}
            </li>
          ))}
        </ul>
        <ul className="space-y-2 overflow-hidden">
          {right.map((b, i) => (
            <li key={i} className="flex items-start gap-3 text-sm" style={{ color: theme.colors.text }}>
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />
              {b}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ComparisonSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const left = toArray(slide.left)
  const right = toArray(slide.right)
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
        <div className="rounded-lg p-5 overflow-hidden" style={{ background: theme.colors.surface }}>
          {slide.leftTitle && <h3 className="text-base font-semibold mb-3" style={{ color: theme.colors.primary }}>{slide.leftTitle}</h3>}
          <ul className="space-y-2">
            {left.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm" style={{ color: theme.colors.text }}>
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />{b}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg p-5 overflow-hidden" style={{ background: theme.colors.surface }}>
          {slide.rightTitle && <h3 className="text-base font-semibold mb-3" style={{ color: theme.colors.primary }}>{slide.rightTitle}</h3>}
          <ul className="space-y-2">
            {right.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm" style={{ color: theme.colors.text }}>
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />{b}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
function ImageTextSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const bullets = toArray(slide.body)
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
        <div className="rounded-lg flex items-center justify-center" style={{ background: theme.colors.surface }}>
          <span className="text-sm" style={{ color: theme.colors.textSecondary }}>{slide.image ?? '[图片占位]'}</span>
        </div>
        <ul className="space-y-2 overflow-hidden py-2">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-3 text-sm" style={{ color: theme.colors.text }}>
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: theme.colors.accent }} />{b}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function StatsSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const stats = slide.stats ?? []
  const cols = Math.min(stats.length, 4)
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <div className="flex-1 grid gap-4 min-h-0" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {stats.map((s, i) => (
          <div key={i} className="rounded-lg flex flex-col items-center justify-center p-4" style={{ background: theme.colors.surface }}>
            <span className="text-3xl font-bold" style={{ color: theme.colors.accent }}>{s.value}</span>
            <span className="mt-2 text-sm" style={{ color: theme.colors.textSecondary }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TimelineSlide({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  const items = slide.items ?? []
  return (
    <div className="w-full h-full flex flex-col px-10 py-8" style={{ background: theme.colors.background }}>
      <h2 className="text-2xl font-bold mb-6 shrink-0" style={{ color: theme.colors.primary }}>{slide.title}</h2>
      <div className="flex-1 flex flex-col gap-3 overflow-hidden">
        {items.map((t, i) => (
          <div key={i} className="flex items-start gap-4">
            <div className="flex flex-col items-center shrink-0">
              <div className="w-3 h-3 rounded-full" style={{ background: theme.colors.primary }} />
              {i < items.length - 1 && <div className="w-0.5 flex-1 mt-1" style={{ background: theme.colors.surface }} />}
            </div>
            <div className="pb-2">
              <span className="text-sm font-semibold" style={{ color: theme.colors.accent }}>{t.time}</span>
              <p className="text-sm mt-0.5" style={{ color: theme.colors.text }}>{t.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Slide Dispatcher ──────────────────────────────────

function SlideView({ slide, theme }: { slide: SlideItem; theme: SlideTheme }) {
  switch (slide.layout) {
    case 'title': return <TitleSlide slide={slide} theme={theme} />
    case 'section': return <SectionSlide slide={slide} theme={theme} />
    case 'content': return <ContentSlide slide={slide} theme={theme} />
    case 'two-column': return <TwoColumnSlide slide={slide} theme={theme} />
    case 'comparison': return <ComparisonSlide slide={slide} theme={theme} />
    case 'image-text': return <ImageTextSlide slide={slide} theme={theme} />
    case 'stats': return <StatsSlide slide={slide} theme={theme} />
    case 'timeline': return <TimelineSlide slide={slide} theme={theme} />
    default: return <ContentSlide slide={slide} theme={theme} />
  }
}

// ─── Main Component ──────────────────────────────────

export function SlidesRenderer({ content, streaming }: SlidesRendererProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const theme = defaultTheme

  const { deck, error } = useMemo(() => {
    if (streaming || !content.trim()) return { deck: null, error: null }
    const parsed = parseSlidesDeck(content)
    if (!parsed) return { deck: null, error: '幻灯片 JSON 解析失败' }
    return { deck: parsed, error: null }
  }, [content, streaming])

  const total = deck?.slides.length ?? 0

  useEffect(() => {
    if (total > 0 && currentIndex >= total) setCurrentIndex(total - 1)
  }, [total, currentIndex])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setCurrentIndex((i) => Math.max(0, i - 1))
    else if (e.key === 'ArrowRight') setCurrentIndex((i) => Math.min((total || 1) - 1, i + 1))
    else if (e.key === 'Escape' && fullscreen) setFullscreen(false)
  }, [total, fullscreen])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (streaming) {
    return (
      <div className="h-full relative">
        <div className="absolute top-3 right-3 flex items-center gap-1.5 text-xs text-accent z-10">
          <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          生成中…
        </div>
        <ScrollArea className="h-full">
          <pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">{content}</pre>
        </ScrollArea>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-2 bg-error-light text-error text-sm border-b border-error/20">{error}</div>
        <ScrollArea className="flex-1">
          <pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">{content}</pre>
        </ScrollArea>
      </div>
    )
  }

  if (!deck) return null
  const slide = deck.slides[currentIndex]
  if (!slide) return null

  const slideContent = (
    <>
      {/* 16:9 slide area */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-black/5">
        <div className={cn("relative w-full aspect-[16/9] overflow-hidden rounded-lg shadow-lg", fullscreen && "rounded-none shadow-none")}>
          <SlideView slide={slide} theme={theme} />
        </div>
      </div>
      {/* Navigation bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border-light bg-background-secondary shrink-0">
        <button
          onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          disabled={currentIndex === 0}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <span className="text-xs text-text-secondary tabular-nums">
          {currentIndex + 1} / {total}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurrentIndex((i) => Math.min(total - 1, i + 1))}
            disabled={currentIndex === total - 1}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} strokeWidth={1.75} />
          </button>
          <button
            onClick={() => setFullscreen((f) => !f)}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title={fullscreen ? '退出全屏' : '全屏'}
          >
            {fullscreen ? <Minimize2 size={14} strokeWidth={1.75} /> : <Maximize2 size={14} strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </>
  )

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex flex-col">
        {slideContent}
      </div>
    )
  }

  return <div className="h-full flex flex-col">{slideContent}</div>
}
