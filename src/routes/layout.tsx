import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Header } from '@/components/layout/header'
import { Sidebar } from '@/components/layout/sidebar'
import { useUIStore } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { isEnabled } from '@/lib/harness/flags'
import { cn } from '@/lib/utils'
import { ProjectRail } from '@/components/layout/project-rail'

export function MainLayout() {
  const { sidebarOpen, sidebarWidth, toggleSidebar } = useUIStore()
  const initializeWorkspace = useWorkspaceStore((state) => state.initialize)
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const setSidebarWidth = useUIStore((state) => state.setSidebarWidth)
  const location = useLocation()
  const compactRail = useNarrowWorkbench()
  const workbench = isEnabled('workbenchV2') && isEnabled('localWorkspace') && Boolean(workspaceRoot) && location.pathname.startsWith('/chat')

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!workbench || compactRail) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.min(360, Math.max(220, moveEvent.clientX)))
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [compactRail, setSidebarWidth, workbench])

  useEffect(() => {
    if (isEnabled('localWorkspace')) void initializeWorkspace()
  }, [initializeWorkspace])

  return (
    <div className="h-full flex flex-col">
      <Header />
      <div className="relative flex flex-1 overflow-hidden">
        <button
          type="button"
          aria-label="关闭侧边栏"
          onClick={toggleSidebar}
          className={cn('absolute inset-0 z-30 hidden bg-black/20 md:hidden', sidebarOpen && 'max-md:block')}
        />
        {/* 侧边栏 */}
        <div
          className={cn(
            'z-40 shrink-0 overflow-hidden border-r border-border-light bg-background-secondary transition-[width] duration-300 ease-[var(--ease-default)]',
            'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg',
            sidebarOpen ? 'w-[min(85vw,var(--sidebar-width))] md:w-[var(--sidebar-width)]' : 'w-0',
          )}
          style={{ '--sidebar-width': `${workbench && compactRail ? 44 : sidebarWidth}px` } as CSSProperties}
        >
          <div className="h-full w-[min(85vw,var(--sidebar-width))] md:w-[var(--sidebar-width)]">
            {workbench ? <ProjectRail compact={compactRail} /> : <Sidebar />}
          </div>
        </div>
        {workbench && sidebarOpen && !compactRail && <div role="separator" aria-label="调整项目栏宽度" onPointerDown={startResize} className="relative z-40 w-px shrink-0 cursor-col-resize bg-border-light hover:bg-accent"><span className="absolute inset-y-0 -left-1 -right-1" /></div>}

        {/* 主内容区 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

function useNarrowWorkbench(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1120)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1119px)')
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}
