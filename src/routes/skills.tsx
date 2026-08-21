import { useEffect, useState } from 'react'
import { ArrowLeft, Check, Download, FileCode2, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { isEnabled } from '@/lib/harness/flags'
import { useSkillRegistry } from '@/hooks/use-skill-registry'
import { parseSkillDocument } from '@/lib/skills/parse'
import { removeUserSkillDirectory, writeUserSkillDocument, writeUserSkillPackage } from '@/lib/skills/migration'
import { createSkillPackage, packageFileText, readSkillPackage } from '@/lib/skills/package'
import { isSkillAutoRouteEnabled, isSkillEnabled, setSkillAutoRouteEnabled, setSkillEnabled } from '@/lib/skills/settings'
import { isTauri, openFileDialog, readBinaryFile } from '@/lib/tauri'
import type { LoadedSkill, SkillMetadata } from '@/lib/skills/types'

function documentFor(skill: LoadedSkill): string {
  const metadata = skill.metadata
  const lines = [
    '---',
    `name: ${metadata.name}`,
    `version: ${metadata.version}`,
    `displayName: ${JSON.stringify(metadata.displayName ?? metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
  ]
  if (metadata.icon) lines.push(`icon: ${metadata.icon}`)
  if (metadata.placeholder) lines.push(`placeholder: ${JSON.stringify(metadata.placeholder)}`)
  if (metadata.author) lines.push(`author: ${JSON.stringify(metadata.author)}`)
  if (metadata.allowedTools) lines.push(`allowed-tools: [${metadata.allowedTools.join(', ')}]`)
  if (metadata.recommendedModels) lines.push(`recommended-models: [${metadata.recommendedModels.join(', ')}]`)
  if (metadata.tags) lines.push(`tags: ${JSON.stringify(metadata.tags)}`)
  if (metadata.stage) lines.push(`stage: ${JSON.stringify(metadata.stage)}`)
  if (metadata.skipConfirmation !== undefined) lines.push(`skip-confirmation: ${metadata.skipConfirmation}`)
  lines.push('---', '', skill.content.trim(), '')
  return lines.join('\n')
}

function sourceLabel(source?: string): string {
  if (source === 'project') return '项目级'
  if (source === 'user') return '用户级'
  return '内置'
}

export function SkillsPage() {
  const navigate = useNavigate()
  const registryState = useSkillRegistry()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ name: string | null; value: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [autoRoute, setAutoRoute] = useState(() => isSkillAutoRouteEnabled())

  const selectedMetadata = registryState.allSkills.find((skill) => skill.name === selectedName)
  useEffect(() => {
    if (!selectedName && registryState.allSkills.length > 0) setSelectedName(registryState.allSkills[0].name)
    if (selectedName && !registryState.allSkills.some((skill) => skill.name === selectedName)) setSelectedName(null)
  }, [registryState.allSkills, selectedName])

  const startCreate = () => {
    setMessage(null)
    setEditor({
      name: null,
      value: '---\nname: my-skill\nversion: 1.0.0\ndisplayName: 我的 Skill\ndescription: 描述这个 Skill 何时使用\nallowed-tools: [read_file]\n---\n\n# 工作流\n\n',
    })
  }

  const startEdit = async (metadata: SkillMetadata) => {
    if (!registryState.registry) return
    const skill = await registryState.registry.resolve(metadata.name)
    if (!skill) return
    setMessage(null)
    setEditor({ name: metadata.name, value: documentFor(skill) })
  }

  const saveEditor = async () => {
    if (!editor) return
    try {
      const parsed = parseSkillDocument(editor.value, `${editor.name ?? 'new-skill'}/SKILL.md`, 'user')
      if (editor.name && parsed.metadata.name !== editor.name) {
        throw new Error('编辑现有 Skill 时不能修改 name；请新建 Skill 后再删除旧目录。')
      }
      if (!isTauri) throw new Error('Web 端只能查看内置 Skill，不能写入目录')
      await writeUserSkillDocument(parsed.metadata.name, editor.value)
      await registryState.refresh()
      setSelectedName(parsed.metadata.name)
      setEditor(null)
      setMessage('Skill 已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteSkill = async (metadata: SkillMetadata) => {
    if (metadata.source !== 'user') return
    try {
      await removeUserSkillDirectory(metadata.name)
      await registryState.refresh()
      setSelectedName(null)
      setMessage('Skill 已删除')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const exportSelected = async () => {
    if (!selectedName || !registryState.registry) return
    try {
      const skill = await registryState.registry.resolve(selectedName)
      if (!skill) throw new Error('Skill 不存在')
      const blob = await createSkillPackage(skill)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${skill.metadata.name}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage('Skill 已导出')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const importPackage = async (file: Blob | ArrayBuffer | Uint8Array) => {
    try {
      const files = await readSkillPackage(file)
      const parsed = parseSkillDocument(packageFileText(files['SKILL.md']), 'SKILL.md', 'user')
      if (!isTauri) throw new Error('Web 端不能导入用户级 Skill')
      const existing = registryState.allSkills.find((skill) => skill.name === parsed.metadata.name)
      if (existing?.source === 'project') throw new Error('同名项目级 Skill 正在生效，不能从管理页覆盖。')
      if (existing?.source === 'user' && !window.confirm(`用户级 Skill “${parsed.metadata.name}” 已存在，是否完整替换？`)) return
      await writeUserSkillPackage(parsed.metadata.name, files)
      await registryState.refresh()
      setSelectedName(parsed.metadata.name)
      setMessage('Skill 已导入')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const selectImportPackage = async () => {
    setMessage(null)
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return
      const bytes = await readBinaryFile(path)
      if (!bytes) throw new Error('无法读取所选 Skill ZIP，请确认文件仍然存在且应用有读取权限。')
      await importPackage(bytes)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleSkill = async (metadata: SkillMetadata) => {
    setSkillEnabled(metadata.name, !isSkillEnabled(metadata.name))
    await registryState.refresh()
  }

  const toggleAutoRoute = () => {
    setSkillAutoRouteEnabled(!autoRoute)
    setAutoRoute(!autoRoute)
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 sm:px-6 border-b border-border-light bg-surface">
        <Button variant="ghost" size="icon" onClick={() => navigate('/settings')} aria-label="返回设置">
          <ArrowLeft size={18} strokeWidth={1.75} />
        </Button>
        <Sparkles size={17} className="text-accent" />
        <h1 className="text-base font-semibold text-text-primary">Skill 管理</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => void registryState.refresh()} aria-label="刷新 Skill">
            <RefreshCw size={16} strokeWidth={1.75} />
          </Button>
          <Button variant="secondary" onClick={startCreate} disabled={!isTauri}>
            <Plus size={16} strokeWidth={1.75} />
            新建
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void selectImportPackage()} disabled={!isTauri} aria-label="导入 Skill ZIP" title="导入 Skill ZIP">
            <Upload size={16} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void exportSelected()} disabled={!selectedName} aria-label="导出 Skill">
            <Download size={16} strokeWidth={1.75} />
          </Button>
        </div>
      </header>

      {!isEnabled('skillV2') && (
        <div className="mx-4 mt-4 rounded-md border border-warning/30 bg-warning-light px-4 py-3 text-sm text-text-secondary">
          `skillV2` 当前未开启；此页面只用于预览目录式 Skill。
        </div>
      )}
      {message && <div className="mx-4 mt-3 rounded-md border border-border bg-surface px-4 py-2 text-sm text-text-secondary">{message}</div>}

      <div className="mx-4 mt-3 flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">自动选择 Skill</p>
          <p className="mt-0.5 text-xs text-text-tertiary">
            没有在输入框用 / 指定技能时，先用一次轻量分类判断该启用哪个 Skill。关闭后只能手动选择。
          </p>
        </div>
        <Button variant={autoRoute ? 'secondary' : 'ghost'} onClick={toggleAutoRoute} aria-pressed={autoRoute}>
          {autoRoute ? '已开启' : '已关闭'}
        </Button>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-0">
        <ScrollArea className="border-r border-border-light">
          <div className="p-3 space-y-1">
            {registryState.loading && <p className="px-3 py-6 text-sm text-text-tertiary">加载 Skill...</p>}
            {!registryState.loading && registryState.skills.length === 0 && <p className="px-3 py-6 text-sm text-text-tertiary">暂无可用 Skill</p>}
            {registryState.allSkills.map((skill) => (
              <button
                key={`${skill.source}:${skill.name}`}
                type="button"
                onClick={() => setSelectedName(skill.name)}
                className={cn('w-full text-left rounded-md px-3 py-2.5 transition-colors', selectedName === skill.name ? 'bg-accent-light' : 'hover:bg-surface-hover')}
              >
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className={selectedName === skill.name ? 'text-accent' : 'text-text-tertiary'} />
                  <span className="text-sm font-medium text-text-primary truncate">{skill.displayName ?? skill.name}</span>
                </div>
                <p className="mt-1 text-xs text-text-tertiary truncate">{skill.description}</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">{sourceLabel(skill.source)} · v{skill.version}{!isSkillEnabled(skill.name) && ' · 已禁用'}</p>
                </button>
              ))}
            {registryState.errors.length > 0 && (
              <div className="mt-3 rounded-md border border-error/30 bg-error-light p-3 text-xs text-error space-y-1">
                {registryState.errors.map((error) => <p key={`${error.path}:${error.message}`}>{error.message}</p>)}
              </div>
            )}
          </div>
        </ScrollArea>

        <ScrollArea>
          <div className="max-w-3xl p-5 sm:p-8">
            {editor ? (
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">{editor.name ? '编辑 Skill' : '新建 Skill'}</h2>
                    <p className="text-sm text-text-tertiary mt-1">保存前会严格校验 frontmatter。</p>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => void saveEditor()}><Check size={16} />保存</Button>
                    <Button variant="ghost" onClick={() => setEditor(null)}><X size={16} />取消</Button>
                  </div>
                </div>
                <textarea value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} className="min-h-[520px] w-full resize-y rounded-md border border-border bg-surface px-4 py-3 font-mono text-sm text-text-primary outline-none focus:border-border-focus" spellCheck={false} />
              </section>
            ) : selectedMetadata ? (
              <SkillDetail metadata={selectedMetadata} enabled={isSkillEnabled(selectedMetadata.name)} onToggle={() => void toggleSkill(selectedMetadata)} onEdit={() => void startEdit(selectedMetadata)} onDelete={() => void deleteSkill(selectedMetadata)} />
            ) : (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-text-tertiary">选择一个 Skill 查看详情</div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function SkillDetail({ metadata, enabled, onToggle, onEdit, onDelete }: { metadata: SkillMetadata; enabled: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <section className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-md bg-accent-light flex items-center justify-center"><Sparkles size={20} className="text-accent" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-text-primary">{metadata.displayName ?? metadata.name}</h2>
          <p className="mt-1 text-sm text-text-tertiary">{metadata.description}</p>
        </div>
        <div className="flex gap-1">
          <Button variant={enabled ? 'secondary' : 'ghost'} size="sm" onClick={onToggle}>{enabled ? '已启用' : '已禁用'}</Button>
          {metadata.source === 'user' && <><Button variant="ghost" size="icon" onClick={onEdit} aria-label="编辑 Skill"><Pencil size={16} /></Button><Button variant="ghost" size="icon" onClick={onDelete} aria-label="删除 Skill"><Trash2 size={16} className="text-error" /></Button></>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Info label="名称" value={metadata.name} mono />
        <Info label="版本" value={metadata.version} mono />
        <Info label="来源" value={sourceLabel(metadata.source)} />
        <Info label="工具" value={metadata.allowedTools?.join(', ') ?? '默认只读工具集'} />
      </div>
      <div className="rounded-md border border-border bg-surface p-4 text-sm text-text-secondary">
        <div className="flex items-center gap-2 font-medium text-text-primary"><FileCode2 size={16} />渐进式披露</div>
        <p className="mt-2 leading-6">第 0 层注入名称和描述；选中后注入 SKILL.md；详细规范由 Agent 按需读取 reference/、examples/ 或 assets/。</p>
      </div>
    </section>
  )
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-md border border-border-light bg-background-secondary px-3 py-2"><p className="text-xs text-text-tertiary">{label}</p><p className={cn('mt-1 text-text-primary truncate', mono && 'font-mono text-xs')}>{value}</p></div>
}
