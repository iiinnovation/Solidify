/**
 * Hook: 全局搜索
 *
 * 与 SearchModal 组件分开放置：组件文件混入非组件导出会破坏 Fast Refresh。
 */

import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { HOTKEYS } from '@/lib/hotkeys'

export function useGlobalSearch() {
  const [open, setOpen] = useState(false)

  useHotkeys(HOTKEYS.SEARCH, () => setOpen(true), { preventDefault: true })

  return {
    open,
    openSearch: () => setOpen(true),
    closeSearch: () => setOpen(false),
  }
}
