import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="inline-flex items-center rounded-md border border-border bg-surface p-0.5 gap-0.5">
      {themes.map((t) => {
        const Icon = t.icon
        const isActive = theme === t.value
        return (
          <button
            key={t.value}
            onClick={() => setTheme(t.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
              isActive
                ? "bg-background text-text-primary shadow-sm"
                : "text-text-tertiary hover:text-text-secondary"
            )}
            title={t.label}
          >
            <Icon size={12} strokeWidth={1.75} />
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}
