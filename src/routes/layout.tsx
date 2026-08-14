import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { Outlet } from 'react-router-dom'
import { Header } from '@/components/layout/header'
import { Sidebar } from '@/components/layout/sidebar'
import { useUIStore } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { isEnabled } from '@/lib/harness/flags'
import { cn } from '@/lib/utils'

export function MainLayout() {
  const { sidebarOpen, sidebarWidth, toggleSidebar } = useUIStore()
  const initializeWorkspace = useWorkspaceStore((state) => state.initialize)

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
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <div className="h-full w-[min(85vw,var(--sidebar-width))] md:w-[var(--sidebar-width)]">
            <Sidebar />
          </div>
        </div>

        {/* 主内容区 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
