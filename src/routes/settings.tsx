import { useState } from 'react'
import { Plus, Trash2, Eye, EyeOff, ChevronLeft, Pencil, Check, X, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  useModelStore,
  providerTemplates,
  type ModelProvider,
  type ApiFormat,
} from '@/stores/model-store'
import { useSkillStore, type CustomSkill } from '@/stores/skill-store'
import { builtinSkills } from '@/lib/skills'
import { useNavigate } from 'react-router-dom'

function ProviderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ModelProvider
  onSave: (data: Omit<ModelProvider, 'id'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [modelId, setModelId] = useState(initial?.modelId ?? '')
  const [format, setFormat] = useState<ApiFormat>(initial?.format ?? 'openai')
  const [showKey, setShowKey] = useState(false)

  const isValid = name.trim() && apiUrl.trim() && apiKey.trim() && modelId.trim()

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：DeepSeek Chat"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">API 格式</label>
        <div className="flex gap-2">
          {(['openai', 'anthropic'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm border transition-all",
                format === f
                  ? "border-accent bg-accent-light text-accent-hover font-medium"
                  : "border-border text-text-secondary hover:border-border-focus"
              )}
            >
              {f === 'openai' ? 'OpenAI 兼容' : 'Anthropic'}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-tertiary">
          大部分反代和 newApi 使用 OpenAI 兼容格式
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">API URL</label>
        <input
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://api.example.com/v1/chat/completions"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">API Key</label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-md border border-border bg-surface px-3 py-2 pr-10 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-secondary"
          >
            {showKey ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </button>
        </div>
        <p className="text-xs text-text-tertiary">
          Key 仅存储在浏览器本地，不会上传到服务器
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">模型 ID</label>
        <input
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="例如：gpt-4o, deepseek-chat, claude-sonnet-4-20250514"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="flex gap-2 pt-2">
        <Button
          onClick={() =>
            onSave({ name, apiUrl, apiKey, modelId, format, enabled: true })
          }
          disabled={!isValid}
        >
          <Check size={16} strokeWidth={1.75} />
          保存
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X size={16} strokeWidth={1.75} />
          取消
        </Button>
      </div>
    </div>
  )
}

function TemplateList({ onSelect }: { onSelect: (template: typeof providerTemplates[number]) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-secondary">选择一个预设模板快速添加，或选择「自定义」手动配置：</p>
      <div className="grid grid-cols-2 gap-2">
        {providerTemplates.map((t, i) => (
          <button
            key={i}
            onClick={() => onSelect(t)}
            className="text-left px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-border-focus hover:shadow-xs transition-all"
          >
            <p className="text-sm font-medium text-text-primary">{t.name}</p>
            <p className="text-xs text-text-tertiary mt-0.5 font-mono truncate">
              {t.apiUrl || '自定义 URL'}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}

function SkillForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomSkill
  onSave: (data: Omit<CustomSkill, 'id' | 'isCustom'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? 'Sparkles')
  const [placeholder, setPlaceholder] = useState(initial?.placeholder ?? '')
  const [skipConfirmation, setSkipConfirmation] = useState(initial?.skipConfirmation ?? true)
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '')

  const isValid = name.trim() && description.trim() && systemPrompt.trim()

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">技能名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：客户画像分析"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">简短描述</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明这个技能的用途"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">图标名称</label>
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="Lucide 图标名称，如 Sparkles"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
        <p className="text-xs text-text-tertiary">
          参考 <a href="https://lucide.dev/icons/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Lucide Icons</a>
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">输入框占位符</label>
        <input
          value={placeholder}
          onChange={(e) => setPlaceholder(e.target.value)}
          placeholder="选中技能后输入框显示的提示文字"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={skipConfirmation}
            onChange={(e) => setSkipConfirmation(e.target.checked)}
            className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
          />
          <span className="text-sm font-medium text-text-primary">跳过确认（直接输出结果）</span>
        </label>
        <p className="text-xs text-text-tertiary">
          勾选后，AI 会直接按技能要求输出，不会先分析再确认
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-primary">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="详细描述 AI 应该如何执行这个技能，包括输出格式、注意事项等"
          rows={8}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)] resize-y"
        />
        <p className="text-xs text-text-tertiary">
          参考内置技能的 systemPrompt 格式，使用 Markdown 编写
        </p>
      </div>

      <div className="flex gap-2 pt-2">
        <Button
          onClick={() =>
            onSave({ name, description, icon, placeholder, skipConfirmation, systemPrompt })
          }
          disabled={!isValid}
        >
          <Check size={16} strokeWidth={1.75} />
          保存
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X size={16} strokeWidth={1.75} />
          取消
        </Button>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { providers, activeProviderId, removeProvider, addProvider, updateProvider, setActiveProvider } =
    useModelStore()
  const { customSkills, addSkill, updateSkill, removeSkill } = useSkillStore()

  const [view, setView] = useState<'list' | 'add-template' | 'add-form' | 'edit'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formDefaults, setFormDefaults] = useState<Partial<ModelProvider>>({})

  const [skillView, setSkillView] = useState<'list' | 'add' | 'edit'>('list')
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)

  const editingProvider = editingId ? providers.find((p) => p.id === editingId) : null
  const editingSkill = editingSkillId ? customSkills.find((s) => s.id === editingSkillId) : null

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="h-12 flex items-center gap-3 px-6 border-b border-border-light shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/chat')}>
          <ChevronLeft size={20} strokeWidth={1.75} />
        </Button>
        <h1 className="text-base font-semibold text-text-primary">设置</h1>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          {/* AI 模型配置区 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">AI 模型配置</h2>
                <p className="text-sm text-text-tertiary mt-1">
                  添加和管理 AI 模型 Provider，支持官方 API、反代、newApi 等
                </p>
              </div>
              {view === 'list' && (
                <Button
                  variant="secondary"
                  onClick={() => setView('add-template')}
                >
                  <Plus size={16} strokeWidth={1.75} />
                  添加
                </Button>
              )}
            </div>

            <Separator />

            {/* 添加流程：选模板 */}
            {view === 'add-template' && (
              <div className="space-y-4">
                <TemplateList
                  onSelect={(template) => {
                    setFormDefaults({
                      name: template.name,
                      apiUrl: template.apiUrl,
                      modelId: template.modelId,
                      format: template.format,
                    })
                    setView('add-form')
                  }}
                />
                <Button variant="ghost" onClick={() => setView('list')}>
                  取消
                </Button>
              </div>
            )}

            {/* 添加流程：填写表单 */}
            {view === 'add-form' && (
              <ProviderForm
                initial={formDefaults as ModelProvider}
                onSave={(data) => {
                  addProvider(data)
                  setView('list')
                }}
                onCancel={() => setView('list')}
              />
            )}

            {/* 编辑表单 */}
            {view === 'edit' && editingProvider && (
              <ProviderForm
                initial={editingProvider}
                onSave={(data) => {
                  updateProvider(editingProvider.id, data)
                  setEditingId(null)
                  setView('list')
                }}
                onCancel={() => {
                  setEditingId(null)
                  setView('list')
                }}
              />
            )}

            {/* Provider 列表 */}
            {view === 'list' && (
              <div className="space-y-2">
                {providers.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-sm text-text-tertiary">
                      还没有配置任何模型，点击「添加」开始
                    </p>
                  </div>
                ) : (
                  providers.map((provider) => {
                    const isActive = provider.id === activeProviderId
                    return (
                      <div
                        key={provider.id}
                        className={cn(
                          "flex items-center justify-between px-4 py-3 rounded-lg border transition-all",
                          isActive
                            ? "border-accent bg-accent-light"
                            : "border-border bg-surface"
                        )}
                      >
                        <button
                          className="flex-1 text-left min-w-0"
                          onClick={() => setActiveProvider(provider.id)}
                        >
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-text-primary truncate">
                              {provider.name}
                            </p>
                            {isActive && (
                              <span className="text-xs text-accent font-medium shrink-0">
                                当前使用
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-text-tertiary font-mono mt-0.5 truncate">
                            {provider.modelId} · {provider.format}
                          </p>
                        </button>
                        <div className="flex items-center gap-1 shrink-0 ml-3">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditingId(provider.id)
                              setView('edit')
                            }}
                          >
                            <Pencil size={14} strokeWidth={1.75} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeProvider(provider.id)}
                          >
                            <Trash2 size={14} strokeWidth={1.75} className="text-error" />
                          </Button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </section>

          {/* 自定义技能管理区 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">自定义技能</h2>
                <p className="text-sm text-text-tertiary mt-1">
                  添加项目专属的技能模板，通过 / 快捷调用
                </p>
              </div>
              {skillView === 'list' && (
                <Button
                  variant="secondary"
                  onClick={() => setSkillView('add')}
                >
                  <Plus size={16} strokeWidth={1.75} />
                  添加
                </Button>
              )}
            </div>

            <Separator />

            {/* 添加技能表单 */}
            {skillView === 'add' && (
              <SkillForm
                onSave={(data) => {
                  addSkill(data)
                  setSkillView('list')
                }}
                onCancel={() => setSkillView('list')}
              />
            )}

            {/* 编辑技能表单 */}
            {skillView === 'edit' && editingSkill && (
              <SkillForm
                initial={editingSkill}
                onSave={(data) => {
                  updateSkill(editingSkill.id, data)
                  setEditingSkillId(null)
                  setSkillView('list')
                }}
                onCancel={() => {
                  setEditingSkillId(null)
                  setSkillView('list')
                }}
              />
            )}

            {/* 技能列表 */}
            {skillView === 'list' && (
              <div className="space-y-4">
                {/* 内置技能（只读） */}
                <div>
                  <h3 className="text-sm font-medium text-text-secondary mb-2">内置技能</h3>
                  <div className="space-y-2">
                    {builtinSkills.map((skill) => (
                      <div
                        key={skill.id}
                        className="flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-surface/50"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Sparkles size={14} strokeWidth={1.75} className="text-text-tertiary shrink-0" />
                            <p className="text-sm font-medium text-text-primary">{skill.name}</p>
                          </div>
                          <p className="text-xs text-text-tertiary mt-0.5 truncate">
                            {skill.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 自定义技能 */}
                {customSkills.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-text-secondary mb-2">自定义技能</h3>
                    <div className="space-y-2">
                      {customSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-surface"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Sparkles size={14} strokeWidth={1.75} className="text-accent shrink-0" />
                              <p className="text-sm font-medium text-text-primary">{skill.name}</p>
                            </div>
                            <p className="text-xs text-text-tertiary mt-0.5 truncate">
                              {skill.description}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-3">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditingSkillId(skill.id)
                                setSkillView('edit')
                              }}
                            >
                              <Pencil size={14} strokeWidth={1.75} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeSkill(skill.id)}
                            >
                              <Trash2 size={14} strokeWidth={1.75} className="text-error" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {customSkills.length === 0 && (
                  <div className="text-center py-8 border border-dashed border-border rounded-lg">
                    <Sparkles size={32} strokeWidth={1.5} className="mx-auto text-text-tertiary mb-2" />
                    <p className="text-sm text-text-tertiary">
                      还没有自定义技能，点击「添加」创建项目专属技能
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
