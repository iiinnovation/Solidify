/**
 * Hook: 全局快捷键帮助面板
 *
 * 与 HotkeyHelp 组件分开放置：组件文件混入非组件导出会破坏 Fast Refresh。
 */

import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { HOTKEYS } from '@/lib/hotkeys'

export function useHotkeyHelp() {
  const [open, setOpen] = useState(false)

  useHotkeys(HOTKEYS.HELP, () => setOpen(true), { preventDefault: true })

  return {
    open,
    openHelp: () => setOpen(true),
    closeHelp: () => setOpen(false),
  }
}
