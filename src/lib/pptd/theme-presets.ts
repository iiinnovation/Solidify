import type { PptdTheme } from './types'

export const PPTD_THEME_IDS = ['business-light', 'business-dark', 'editorial', 'data'] as const

export type PptdThemeId = typeof PPTD_THEME_IDS[number]

const THEME_PRESETS: Record<PptdThemeId, PptdTheme> = {
  'business-light': {
    colors: {
      bg: '#F8FAFC',
      surface: '#FFFFFF',
      text: '#172033',
      muted: '#64748B',
      accent: '#2563EB',
      accentSoft: '#DBEAFE',
      positive: '#15803D',
      warning: '#B45309',
    },
    textStyles: {
      title: { fontSize: 32, fontFamily: 'Arial', color: '#172033', bold: true, lineHeight: 1.1 },
      subtitle: { fontSize: 20, fontFamily: 'Arial', color: '#64748B', lineHeight: 1.25 },
      body: { fontSize: 18, fontFamily: 'Arial', color: '#172033', lineHeight: 1.3 },
      caption: { fontSize: 12, fontFamily: 'Arial', color: '#64748B', lineHeight: 1.2 },
    },
  },
  'business-dark': {
    colors: {
      bg: '#111827',
      surface: '#1F2937',
      text: '#F8FAFC',
      muted: '#CBD5E1',
      accent: '#38BDF8',
      accentSoft: '#164E63',
      positive: '#4ADE80',
      warning: '#FBBF24',
    },
    textStyles: {
      title: { fontSize: 32, fontFamily: 'Arial', color: '#F8FAFC', bold: true, lineHeight: 1.1 },
      subtitle: { fontSize: 20, fontFamily: 'Arial', color: '#CBD5E1', lineHeight: 1.25 },
      body: { fontSize: 18, fontFamily: 'Arial', color: '#F8FAFC', lineHeight: 1.3 },
      caption: { fontSize: 12, fontFamily: 'Arial', color: '#CBD5E1', lineHeight: 1.2 },
    },
  },
  editorial: {
    colors: {
      bg: '#FFFDF8',
      surface: '#FFFFFF',
      text: '#202124',
      muted: '#6B7280',
      accent: '#C2410C',
      accentSoft: '#FFEDD5',
      positive: '#166534',
      warning: '#A16207',
    },
    textStyles: {
      title: { fontSize: 34, fontFamily: 'Georgia', color: '#202124', bold: true, lineHeight: 1.08 },
      subtitle: { fontSize: 20, fontFamily: 'Arial', color: '#6B7280', lineHeight: 1.25 },
      body: { fontSize: 18, fontFamily: 'Arial', color: '#202124', lineHeight: 1.35 },
      caption: { fontSize: 12, fontFamily: 'Arial', color: '#6B7280', lineHeight: 1.2 },
    },
  },
  data: {
    colors: {
      bg: '#F7F9FC',
      surface: '#FFFFFF',
      text: '#101828',
      muted: '#667085',
      accent: '#0F766E',
      accentSoft: '#CCFBF1',
      positive: '#16A34A',
      warning: '#D97706',
    },
    textStyles: {
      title: { fontSize: 30, fontFamily: 'Arial', color: '#101828', bold: true, lineHeight: 1.1 },
      subtitle: { fontSize: 18, fontFamily: 'Arial', color: '#667085', lineHeight: 1.25 },
      body: { fontSize: 17, fontFamily: 'Arial', color: '#101828', lineHeight: 1.3 },
      caption: { fontSize: 12, fontFamily: 'Arial', color: '#667085', lineHeight: 1.2 },
    },
  },
}

export function getPptdThemePreset(id: PptdThemeId): PptdTheme {
  return structuredClone(THEME_PRESETS[id])
}

export function isPptdThemeId(value: unknown): value is PptdThemeId {
  return typeof value === 'string' && (PPTD_THEME_IDS as readonly string[]).includes(value)
}

export function inferPptdThemeId(text: string): PptdThemeId {
  const normalized = text.toLowerCase()
  if (/深色|暗色|dark|night|黑底/.test(normalized)) return 'business-dark'
  if (/数据|图表|指标|经营|dashboard|data|metric/.test(normalized)) return 'data'
  if (/编辑|杂志|叙事|品牌|editorial|story/.test(normalized)) return 'editorial'
  return 'business-light'
}
