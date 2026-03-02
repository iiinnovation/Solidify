/**
 * 全局快捷键配置
 */

export const HOTKEYS = {
  // 导航
  NEW_CHAT: 'mod+n',
  SEARCH: 'mod+k',
  TOGGLE_SIDEBAR: 'mod+b',
  SETTINGS: 'mod+,',

  // 技能面板
  OPEN_SKILLS: 'mod+/',

  // 通用
  ESCAPE: 'escape',
  HELP: '?',
} as const

export const HOTKEY_LABELS: Record<keyof typeof HOTKEYS, string> = {
  NEW_CHAT: '新建对话',
  SEARCH: '搜索',
  TOGGLE_SIDEBAR: '切换侧边栏',
  SETTINGS: '设置',
  OPEN_SKILLS: '技能面板',
  ESCAPE: '取消',
  HELP: '帮助',
}

/**
 * 格式化快捷键显示（Mac/Windows 适配）
 */
export function formatHotkey(hotkey: string): string {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
  return hotkey
    .replace('mod', isMac ? '⌘' : 'Ctrl')
    .replace('+', isMac ? '' : '+')
    .toUpperCase()
}
