import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useUIStore } from '@/stores/ui-store'

export function Workbench({ chat, viewer, viewerOpen }: { chat: ReactNode; viewer: ReactNode; viewerOpen: boolean }) {
  if (!viewerOpen) {
    return <div className="flex h-full min-w-0 overflow-hidden"><section className="min-w-0 flex-1 overflow-hidden">{chat}</section></div>
  }

  return <OpenWorkbench chat={chat} viewer={viewer} />
}

function OpenWorkbench({ chat, viewer }: { chat: ReactNode; viewer: ReactNode }) {
  const chatPanelWidth = useUIStore((state) => state.chatPanelWidth)
  const setChatPanelWidth = useUIStore((state) => state.setChatPanelWidth)
  const container = useRef<HTMLDivElement>(null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => container.current?.style.setProperty('--chat-width', `${chatPanelWidth}px`), [chatPanelWidth])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      if (!container.current) return
      const rect = container.current.getBoundingClientRect()
      const max = Math.min(520, Math.max(360, rect.width - 300))
      container.current.style.setProperty('--chat-width', `${Math.min(max, Math.max(360, moveEvent.clientX - rect.left))}px`)
    }
    const up = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      if (!container.current) return
      const rect = container.current.getBoundingClientRect()
      const max = Math.min(520, Math.max(360, rect.width - 300))
      setChatPanelWidth(Math.min(max, Math.max(360, upEvent.clientX - rect.left)))
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [maximized, setChatPanelWidth])

  return <div ref={container} className="relative flex h-full min-w-0 overflow-hidden" style={{ '--chat-width': `${chatPanelWidth}px` } as React.CSSProperties}>
    {!maximized && <section className="min-w-0 flex-1 overflow-hidden md:flex-none md:shrink-0" style={{ width: 'min(var(--chat-width), calc(100% - 300px))' }}>{chat}</section>}
    <div role="separator" aria-label="调整对话与文档宽度" title="拖拽调整宽度，双击最大化文档" onPointerDown={startResize} onDoubleClick={() => setMaximized((value) => !value)} className="group relative z-10 hidden w-px shrink-0 cursor-col-resize bg-border-light hover:bg-accent md:block"><span className="absolute inset-y-0 -left-1 -right-1" /></div>
    <section className="absolute inset-0 z-20 min-w-0 overflow-hidden bg-background md:static md:z-auto md:flex-1">{viewer}</section>
  </div>
}
