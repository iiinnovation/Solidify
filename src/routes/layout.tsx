import { Outlet } from 'react-router-dom'
import { Header } from '@/components/layout/header'
import { Sidebar } from '@/components/layout/sidebar'
import { useUIStore } from '@/stores/ui-store'

export function MainLayout() {
  const { sidebarOpen, sidebarWidth } = useUIStore()

  return (
    <div className="h-full flex flex-col">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        {/* 侧边栏 */}
        <div
          className="shrink-0 border-r border-border-light overflow-hidden transition-[width] duration-300 ease-[var(--ease-default)]"
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        >
          <div style={{ width: sidebarWidth }} className="h-full">
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
