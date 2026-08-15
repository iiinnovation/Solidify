import { useState, useRef, useEffect } from 'react'
import { PanelLeftClose, PanelLeftOpen, Settings, LogOut, FileText, BarChart3, BookOpen, FolderTree, Sparkles } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useHotkeys } from 'react-hotkeys-hook'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui-store'
import { useAuthStore } from '@/stores/auth-store'
import { SyncIndicator } from '@/lib/sync'
import { ThemeToggle } from '@/components/shared/theme-toggle'
import { supabaseConfigured } from '@/lib/supabase'
import { isTauri } from '@/lib/tauri'
import { HOTKEYS } from '@/lib/hotkeys'
import { cn } from '@/lib/utils'
import { isEnabled } from '@/lib/harness/flags'

export function Header() {
  const { sidebarOpen, toggleSidebar } = useUIStore()
  const { user, signOut } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 快捷键：切换侧边栏
  useHotkeys(HOTKEYS.TOGGLE_SIDEBAR, toggleSidebar, { preventDefault: true })

  // 快捷键：打开设置
  useHotkeys(HOTKEYS.SETTINGS, () => navigate('/settings'), { preventDefault: true })

  // 点击外部关闭 dropdown
  useEffect(() => {
    if (!dropdownOpen) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  const handleSignOut = async () => {
    setDropdownOpen(false)
    await signOut()
    navigate('/login', { replace: true })
  }

  const initials = user?.email ? user.email[0].toUpperCase() : '?'

  return (
    <header
      className="relative flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-light bg-surface px-2 sm:px-4"
      style={isTauri ? { paddingLeft: '80px' } : undefined}
    >
      {/* 可拖动区域 - 整个 header 背景 */}
      {isTauri && (
        <div
          data-tauri-drag-region
          className="absolute inset-0 z-0"
        />
      )}

      <div className="relative z-10 flex shrink-0 items-center gap-2 sm:gap-3">
        <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="切换侧边栏">
          {sidebarOpen ? (
            <PanelLeftClose size={20} strokeWidth={1.75} />
          ) : (
            <PanelLeftOpen size={20} strokeWidth={1.75} />
          )}
        </Button>
        <span className="text-base font-semibold text-text-primary">
          Solidify
        </span>
      </div>
      <div className="relative z-10 flex min-w-0 items-center gap-0.5 sm:gap-2">
        {/* 导航按钮 */}
        {isEnabled('localWorkspace') && !isEnabled('workbenchV2') && (
          <Button variant="ghost" size="sm" onClick={() => navigate('/workspace')} className={cn(location.pathname === '/workspace' && 'bg-accent-light text-accent')} aria-label="工作区">
            <FolderTree size={18} strokeWidth={1.75} className="sm:mr-1.5" /><span className="hidden sm:inline">工作区</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/knowledge')}
          className={cn(
            location.pathname === '/knowledge' && 'bg-accent-light text-accent'
          )}
          aria-label="知识库"
        >
          <BookOpen size={18} strokeWidth={1.75} className="sm:mr-1.5" />
          <span className="hidden sm:inline">知识库</span>
        </Button>

        {isEnabled('skillV2') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/skills')}
            className={cn(location.pathname === '/skills' && 'bg-accent-light text-accent')}
            aria-label="Skill 管理"
          >
            <Sparkles size={18} strokeWidth={1.75} className="sm:mr-1.5" />
            <span className="hidden sm:inline">Skill</span>
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/templates')}
          className={cn(
            location.pathname === '/templates' && 'bg-accent-light text-accent'
          )}
          aria-label="模板管理"
        >
          <FileText size={18} strokeWidth={1.75} className="sm:mr-1.5" />
          <span className="hidden sm:inline">模板</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/usage')}
          className={cn(
            location.pathname === '/usage' && 'bg-accent-light text-accent'
          )}
          aria-label="用量统计"
        >
          <BarChart3 size={18} strokeWidth={1.75} className="sm:mr-1.5" />
          <span className="hidden sm:inline">用量</span>
        </Button>

        {/* 同步状态指示器 */}
        {supabaseConfigured && <div className="hidden sm:block"><SyncIndicator /></div>}

        {/* 主题切换 */}
        <div className="hidden lg:block"><ThemeToggle /></div>

        <Button variant="ghost" size="icon" onClick={() => navigate('/settings')} aria-label="设置">
          <Settings size={20} strokeWidth={1.75} />
        </Button>

        {/* 用户头像 + 退出 dropdown */}
        {supabaseConfigured && user && (
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-text-primary text-xs font-medium text-text-inverse transition-opacity hover:opacity-85"
              aria-label="用户菜单"
            >
              {initials}
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border-light bg-surface py-1 shadow-lg">
                <div className="px-3 py-2 text-xs text-text-tertiary truncate">
                  {user.email}
                </div>
                <hr className="border-border-light" />
                <button
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  <LogOut size={14} strokeWidth={1.75} />
                  退出登录
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
