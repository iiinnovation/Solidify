import type { FolderTaskRecipePlan } from '@/lib/folder-tasks/types'

const labels: Record<string, string> = {
  summary: '摘要', facts: '提取信息', label: '字段', value: '值', evidence: '原文依据',
  findings: '审查发现', ruleId: '规则', severity: '严重程度', title: '标题',
  description: '说明', recommendation: '建议', category: '分类', confidence: '置信度', rationale: '分类理由',
}

/** Preserve the recipe's value types while presenting ordinary form controls. */
export function FolderTaskResult({ value, onChange, name, recipePlan }: { value: unknown; onChange?: (value: unknown) => void; name?: string; recipePlan?: FolderTaskRecipePlan }) {
  if (Array.isArray(value)) {
    const fields = name === 'facts' && recipePlan?.kind === 'structured-extraction' ? recipePlan.fields : []
    const choices = name === 'findings' && recipePlan?.kind === 'document-review'
      ? recipePlan.rules.map((rule) => ({ id: rule.id, label: rule.title, entry: { ruleId: rule.id, severity: rule.severity, title: rule.title, description: '', ...(rule.evidenceRequired ? { evidence: '' } : {}) } }))
      : fields.filter((field) => !value.some((entry) => [field.name, ...field.aliases].some((label) => label.toLowerCase() === String(entry?.label).toLowerCase())))
        .map((field) => ({ id: field.name, label: field.name, entry: { label: field.name, value: field.type === 'number' ? 0 : field.type === 'boolean' ? false : '' } }))
    return <div className="space-y-3">
      {value.length === 0 && <p className="text-xs text-text-tertiary">无</p>}
      {value.map((entry, index) => {
        const required = fields.some((field) => field.required && [field.name, ...field.aliases].some((label) => label.toLowerCase() === String(entry?.label).toLowerCase()))
        return <div key={index} className="rounded-lg border border-border-light p-3">
          <FolderTaskResult recipePlan={recipePlan} value={entry} onChange={onChange ? (next) => onChange(value.map((item, i) => i === index ? next : item)) : undefined} />
          {onChange && <button type="button" disabled={required} title={required ? '已确认计划中的必填字段不能删除' : undefined} className="mt-2 text-xs text-error disabled:opacity-40" onClick={() => onChange(value.filter((_, i) => i !== index))}>删除{labels[name ?? ''] ?? '条目'}</button>}
        </div>
      })}
      {onChange && choices.length > 0 && <select aria-label={`新增${labels[name ?? ''] ?? '条目'}`} className="rounded border border-border-light bg-surface p-2 text-sm" value="" onChange={(event) => {
        const choice = choices.find((candidate) => candidate.id === event.target.value)
        if (choice) onChange([...value, choice.entry])
      }}><option value="">新增{labels[name ?? ''] ?? '条目'}…</option>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>}
      {onChange && name === 'facts' && recipePlan?.kind === 'structured-extraction' && fields.length === 0 && <button type="button" className="text-xs text-accent" onClick={() => onChange([...value, { label: '', value: '' }])}>新增提取信息</button>}
    </div>
  }
  if (value !== null && typeof value === 'object') return <dl className="space-y-2">{Object.entries(value).map(([key, entry]) => <div key={key}><dt className="mb-1 text-xs font-medium text-text-tertiary">{labels[key] ?? key}</dt><dd><FolderTaskResult recipePlan={recipePlan} name={key} value={entry} onChange={onChange ? (next) => onChange({ ...value, [key]: next }) : undefined} /></dd></div>)}</dl>
  const label = labels[name ?? ''] ?? name
  const fieldClass = 'w-full rounded border border-border-light bg-surface px-2 py-1 text-sm text-text-primary'
  if (onChange && typeof value === 'boolean') return <input aria-label={label} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
  if (onChange && typeof value === 'number') return <input aria-label={label} className={fieldClass} type="number" step="any" value={value} onChange={(event) => onChange(event.target.valueAsNumber)} />
  if (onChange && typeof value === 'string') return <textarea aria-label={label} className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)} />
  return <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{typeof value === 'boolean' ? (value ? '是' : '否') : String(value ?? '未提供')}</p>
}
