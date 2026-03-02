import { useCallback, useEffect, useRef, type ReactNode } from 'react'

interface ResizablePanelProps {
  left: ReactNode
  right: ReactNode
  leftWidth: number
  onResize: (width: number) => void
  minLeft?: number
  maxLeft?: number
}

export function ResizablePanel({
  left,
  right,
  leftWidth,
  onResize,
  minLeft = 360,
  maxLeft = 520,
}: ResizablePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  // 同步 React state → CSS variable
  useEffect(() => {
    containerRef.current?.style.setProperty('--left-w', `${leftWidth}px`)
  }, [leftWidth])

  const handleMouseDown = useCallback(() => {
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const clamped = Math.min(maxLeft, Math.max(minLeft, e.clientX - rect.left))
      // 拖拽中仅更新 CSS variable，不触发 React re-render
      containerRef.current.style.setProperty('--left-w', `${clamped}px`)
    }

    const handleMouseUp = (e: MouseEvent) => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      // 拖拽结束，将最终值提交到 React state（单次 re-render）
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        const clamped = Math.min(maxLeft, Math.max(minLeft, e.clientX - rect.left))
        onResize(clamped)
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [maxLeft, minLeft, onResize])

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden" style={{ '--left-w': `${leftWidth}px` } as React.CSSProperties}>
      <div className="shrink-0 overflow-hidden" style={{ width: 'var(--left-w)' }}>
        {left}
      </div>

      {/* 分隔线 */}
      <div
        className="shrink-0 w-px bg-border-light cursor-col-resize hover:bg-accent transition-colors relative group"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        {right}
      </div>
    </div>
  )
}
