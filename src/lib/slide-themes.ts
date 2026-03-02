export interface SlideTheme {
  id: string
  name: string
  colors: {
    primary: string       // 主色（标题、强调）
    secondary: string     // 辅色
    background: string    // 幻灯片背景
    surface: string       // 卡片/区块背景
    text: string          // 正文颜色
    textSecondary: string // 次要文字
    accent: string        // 高亮/数字
  }
  fonts: {
    heading: string
    body: string
  }
}

/** 内置默认主题（暖色调，匹配 Solidify 设计语言） */
export const defaultTheme: SlideTheme = {
  id: 'default',
  name: '默认主题',
  colors: {
    primary: '#D4915E',
    secondary: '#C47B3B',
    background: '#FFFDF9',
    surface: '#F5F0EB',
    text: '#1A1A1A',
    textSecondary: '#6B6560',
    accent: '#D4915E',
  },
  fonts: {
    heading: 'Inter, "SF Pro Display", -apple-system, "Noto Sans SC", sans-serif',
    body: 'Inter, -apple-system, "Noto Sans SC", sans-serif',
  },
}

/** 主题加载抽象 — Phase 1 返回默认主题，Phase 2 改为 API 获取 */
export async function loadTheme(_themeId?: string): Promise<SlideTheme> {
  return defaultTheme
}
