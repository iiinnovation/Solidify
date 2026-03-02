import { useState, useRef, useEffect } from 'react'
import { Plus, FolderOpen, ChevronDown, Settings, Archive } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useProjects, useCreateProject, useUpdateProject } from '@/hooks/use-projects'
import { useProjectStore } from '@/stores/project-store'
import { supabaseConfigured } from '@/lib/supabase'

function ProjectSelector() {
  const navigate = useNavigate()
  const { data: projects, isLoading } = useProjects()
  const { activeProjectId, setActiveProject } = useProjectStore()
  const createProject = useCreateProject()
  const updateProject = useUpdateProject()
  const [open, setOpen] = useState(false)
  const [showNewProjectForm, setShowNewProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  const activeProject = projects?.find((p) => p.id === activeProjectId)

  // 如果没有选中项目且有项目列表，自动选中第一个
  useEffect(() => {
    if (!activeProjectId && projects && projects.length > 0) {
      setActiveProject(projects[0].id)
    }
  }, [activeProjectId, projects, setActiveProject])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowNewProjectForm(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name) return

    await createProject.mutateAsync({ name })
    setNewProjectName('')
    setShowNewProjectForm(false)
    setOpen(false)
  }

  const handleArchiveProject = async (id: string) => {
    await updateProject.mutateAsync({ id, input: { status: 'archived' } })
    if (activeProjectId === id) {
      const activeProjects = projects?.filter((p) => p.status === 'active' && p.id !== id)
      setActiveProject(activeProjects?.[0]?.id ?? null)
    }
    setOpen(false)
  }

  if (!supabaseConfigured) {
    return (
      <div className="px-3 py-2">
        <div className="text-xs text-text-tertiary">未配置 Supabase</div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="px-3 py-2">
        <div className="text-xs text-text-tertiary">加载中...</div>
      </div>
    )
  }

  const activeProjects = projects?.filter((p) => p.status === 'active') ?? []

  return (
    <div ref={dropdownRef} className="relative px-3 py-2">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition-colors",
          "hover:bg-surface-hover",
          open && "bg-surface-hover"
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={16} strokeWidth={1.75} className="shrink-0 text-text-tertiary" />
          <span className="truncate text-text-primary">
            {activeProject?.name ?? '选择项目'}
          </span>
        </div>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn("shrink-0 text-text-tertiary transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute top-full left-3 right-3 mt-1 rounded-lg border border-border bg-surface shadow-md py-1 z-50 max-h-80 overflow-y-auto">
          {/* 项目列表 */}
          {activeProjects.length > 0 ? (
            <>
              {activeProjects.map((project) => (
                <div key={project.id} className="group relative">
                  <button
                    onClick={() => {
                      setActiveProject(project.id)
                      setOpen(false)
                      navigate('/chat')
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-background-secondary transition-colors",
                      project.id === activeProjectId && "bg-accent-light"
                    )}
                  >
                    <p className="text-sm text-text-primary truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-text-tertiary truncate mt-0.5">{project.description}</p>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleArchiveProject(project.id)
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-hover text-text-tertiary hover:text-text-primary transition-all"
                    title="归档项目"
                  >
                    <Archive size={14} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
              <div className="border-t border-border-light my-1" />
            </>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-text-tertiary">
              还没有项目
            </div>
          )}

          {/* 新建项目表单 */}
          {showNewProjectForm ? (
            <div className="px-3 py-2">
              <input
                autoFocus
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateProject()
                  if (e.key === 'Escape') {
                    setShowNewProjectForm(false)
                    setNewProjectName('')
                  }
                }}
                placeholder="项目名称"
                className="w-full px-2 py-1.5 text-sm bg-background border border-border-focus rounded-md outline-none"
              />
              <div className="flex items-center gap-1 mt-2">
                <Button
                  size="sm"
                  onClick={handleCreateProject}
                  disabled={!newProjectName.trim() || createProject.isPending}
                >
                  创建
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowNewProjectForm(false)
                    setNewProjectName('')
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowNewProjectForm(true)}
              className="w-full text-left px-3 py-2 hover:bg-background-secondary transition-colors flex items-center gap-2 text-sm text-text-secondary"
            >
              <Plus size={14} strokeWidth={1.75} />
              新建项目
            </button>
          )}

          {/* 项目管理入口 */}
          <div className="border-t border-border-light mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false)
                navigate('/settings')
              }}
              className="w-full text-left px-3 py-2 hover:bg-background-secondary transition-colors flex items-center gap-2 text-xs text-text-tertiary"
            >
              <Settings size={12} strokeWidth={1.75} />
              项目管理
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export { ProjectSelector }
