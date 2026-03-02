import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { X, Command } from 'lucide-react'
import { HOTKEYS, HOTKEY_LABELS, formatHotkey } from '@/lib/hotkeys'

interface HotkeyHelpProps {
  open: boolean
  onClose: () => void
}

export function HotkeyHelp({ open, onClose }: HotkeyHelpProps) {
  useHotkeys('escape', onClose, { enabled: open })

  if (!open) return null

  const hotkeyGroups = [
    {
      title: '导航',
      keys: [
        { key: HOTKEYS.NEW_CHAT, label: HOTKEY_LABELS.NEW_CHAT },
        { key: HOTKEYS.SEARCH, label: HOTKEY_LABELS.SEARCH },
        { key: HOTKEYS.TOGGLE_SIDEBAR, label: HOTKEY_LABELS.TOGGLE_SIDEBAR },
        { key: HOTKEYS.SETTINGS, label: HOTKEY_LABELS.SETTINGS },
      ],
    },
    {
      title: '编辑',
      keys: [
        { key: HOTKEYS.OPEN_SKILLS, label: HOTKEY_LABELS.OPEN_SKILLS },
      ],
    },
    {
      title: '通用',
      keys: [
        { key: HOTKEYS.ESCAPE, label: HOTKEY_LABELS.ESCAPE },
        { key: HOTKEYS.HELP, label: HOTKEY_LABELS.HELP },
      ],
    },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-light px-6 py-4">
          <div className="flex items-center gap-2">
            <Command size={20} strokeWidth={1.75} className="text-text-tertiary" />
            <h2 className="text-lg font-semibold text-text-primary">快捷键</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {hotkeyGroups.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-medium text-text-secondary mb-3">{group.title}</h3>
              <div className="space-y-2">
                {group.keys.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-background-secondary transition-colors"
                  >
                    <span className="text-sm text-text-primary">{item.label}</span>
                    <kbd className="inline-flex items-center gap-1 px-2 py-1 rounded bg-background-secondary border border-border text-xs font-mono text-text-secondary">
                      {formatHotkey(item.key)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-border-light px-6 py-3 text-xs text-text-tertiary">
          按 <kbd className="px-1.5 py-0.5 rounded bg-background-secondary border border-border font-mono">?</kbd> 或{' '}
          <kbd className="px-1.5 py-0.5 rounded bg-background-secondary border border-border font-mono">Esc</kbd> 关闭此面板
        </div>
      </div>
    </div>
  )
}

/**
 * Hook: 全局快捷键帮助面板
 */
export function useHotkeyHelp() {
  const [open, setOpen] = useState(false)

  useHotkeys(HOTKEYS.HELP, () => setOpen(true), { preventDefault: true })

  return {
    open,
    openHelp: () => setOpen(true),
    closeHelp: () => setOpen(false),
  }
}
