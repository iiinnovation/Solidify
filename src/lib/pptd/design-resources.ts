import type { PptdTheme } from './types'

export const PPTD_SCENARIOS = [
  'analysis-decision',
  'business-plan',
  'management-report',
  'academic-research',
  'education-training',
  'tech-engineering',
  'brand-creative',
] as const

export type PptdScenario = typeof PPTD_SCENARIOS[number]

export interface PptdDesignSource {
  scenario: PptdScenario
  designSystemId: string
  generalGuidance: string
  scenarioGuidance: string
  designGuidance: string
  examplePage?: string
}

export interface PptdDesignSpec {
  scenario: PptdScenario
  designSystemId: string
  visualSignature: string
  palette: {
    background: string
    surface: string
    text: string
    muted: string
    accent: string
    secondary: string
  }
  typography: {
    titleFont: string
    bodyFont: string
    titleSize: number
    bodySize: number
  }
  layout: { margin: number; columns: number; gutter: number }
  compositionRules: string[]
  componentRules: string[]
  prohibited: string[]
  imageryStyle: string
}

const generalModules = import.meta.glob('../skills/builtin/pptd-deck/reference/slide-categories.md', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>
const scenarioModules = import.meta.glob('../skills/builtin/pptd-deck/reference/slide-categories/*.md', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>
const designModules = import.meta.glob('../skills/builtin/pptd-deck/reference/design-system/**/design.md', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>
const exampleModules = import.meta.glob('../skills/builtin/pptd-deck/examples/kimi/*.page', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>

const GENERAL_GUIDANCE = Object.values(generalModules)[0] ?? ''
const SCENARIO_GUIDANCE = keyedModules(scenarioModules, /slide-categories\/([^/]+)\.md$/)
const DESIGN_GUIDANCE = keyedModules(designModules, /design-system\/(.+)\/design\.md$/)
const EXAMPLE_PAGES = keyedModules(exampleModules, /examples\/kimi\/([^/]+)\.page$/)

export const PPTD_DESIGN_SYSTEM_IDS = Object.freeze(Object.keys(DESIGN_GUIDANCE).sort())

const DEFAULT_DESIGNS: Record<PptdScenario, string> = {
  'analysis-decision': 'consulting/apricot-white-brief',
  'business-plan': 'finance/lake-blue-memo',
  'management-report': 'work/warm-jade-annual-report',
  'academic-research': 'academic/teal-green-academic-defense',
  'education-training': 'academic/blue-line-courseware',
  'tech-engineering': 'work/sky-blue-wayfinding',
  'brand-creative': 'promotion/silver-gray-luxury-magazine',
}

export function resolvePptdDesignSource(text: string, requestedDesignSystemId?: string): PptdDesignSource {
  const scenario = inferPptdScenario(text)
  const requested = requestedDesignSystemId?.trim()
  if (requested && !DESIGN_GUIDANCE[requested]) {
    throw new Error(`未知 PPTD 设计系统：${requested}`)
  }
  const designSystemId = requested || DEFAULT_DESIGNS[scenario]
  return {
    scenario,
    designSystemId,
    generalGuidance: GENERAL_GUIDANCE,
    scenarioGuidance: SCENARIO_GUIDANCE[scenario] ?? '',
    designGuidance: DESIGN_GUIDANCE[designSystemId] ?? '',
    examplePage: exampleForScenario(scenario),
  }
}

export function inferPptdScenario(text: string): PptdScenario {
  const value = text.toLowerCase()
  if (/品牌|创意|作品集|文化|活动|brand|creative|portfolio|campaign/.test(value)) return 'brand-creative'
  if (/教学|培训|课程|科普|教育|入职|course|training|education|onboarding/.test(value)) return 'education-training'
  if (/论文|答辩|研究课题|实验|学术|thesis|research|academic|experiment/.test(value)) return 'academic-research'
  if (/架构|研发|技术方案|安全|运维|api|sdk|architecture|engineering|technical|incident/.test(value)) return 'tech-engineering'
  if (/融资|销售方案|商业计划|合作方案|招商|proposal|pitch|fundraising|business plan/.test(value)) return 'business-plan'
  if (/咨询|行业研究|战略|投资|决策|市场机会|consulting|strategy|investment|decision/.test(value)) return 'analysis-decision'
  return 'management-report'
}

export function fallbackPptdDesignSpec(source: PptdDesignSource, theme: PptdTheme): PptdDesignSpec {
  return {
    scenario: source.scenario,
    designSystemId: source.designSystemId,
    visualSignature: '以结论为标题，以证据为主体，通过明确网格、克制配色和稳定页脚形成专业叙事。',
    palette: {
      background: theme.colors.bg ?? '#F8FAFC',
      surface: theme.colors.surface ?? '#FFFFFF',
      text: theme.colors.text ?? '#172033',
      muted: theme.colors.muted ?? '#64748B',
      accent: theme.colors.accent ?? '#2563EB',
      secondary: theme.colors.accentSoft ?? '#DBEAFE',
    },
    typography: {
      titleFont: theme.textStyles.title?.fontFamily ?? 'Arial',
      bodyFont: theme.textStyles.body?.fontFamily ?? 'Arial',
      titleSize: theme.textStyles.title?.fontSize ?? 32,
      bodySize: theme.textStyles.body?.fontSize ?? 18,
    },
    layout: { margin: 48, columns: 12, gutter: 16 },
    compositionRules: ['每页只有一个可复述结论', '按结论、证据、解释、来源组织阅读顺序', '页面之间交替使用高密度证据页和节奏页'],
    componentRules: ['优先使用图表、表格、时间线和关系图表达结构', '用细线、留白和字号层级建立分组，不默认使用卡片阵列'],
    prohibited: ['禁止无依据的装饰', '禁止重复的等分卡片布局', '禁止虚构数据、来源和案例'],
    imageryStyle: '只使用与结论直接相关的真实图片、界面截图或证据图，并围绕图片比例设计版式。',
  }
}

export function themeFromDesignSpec(base: PptdTheme, design: PptdDesignSpec): PptdTheme {
  return {
    ...base,
    colors: {
      ...base.colors,
      bg: design.palette.background,
      surface: design.palette.surface,
      text: design.palette.text,
      muted: design.palette.muted,
      accent: design.palette.accent,
      accentSoft: design.palette.secondary,
    },
    textStyles: {
      ...base.textStyles,
      title: {
        ...base.textStyles.title,
        fontFamily: design.typography.titleFont,
        fontSize: design.typography.titleSize,
        color: design.palette.text,
        bold: true,
      },
      body: {
        ...base.textStyles.body,
        fontFamily: design.typography.bodyFont,
        fontSize: design.typography.bodySize,
        color: design.palette.text,
      },
      caption: { ...base.textStyles.caption, fontFamily: design.typography.bodyFont, color: design.palette.muted },
    },
  }
}

function keyedModules(modules: Record<string, string>, pattern: RegExp): Record<string, string> {
  return Object.fromEntries(Object.entries(modules).flatMap(([path, content]) => {
    const match = path.replace(/\\/g, '/').match(pattern)
    return match ? [[match[1], content]] : []
  }))
}

function exampleForScenario(scenario: PptdScenario): string | undefined {
  if (scenario === 'brand-creative' || scenario === 'business-plan') return EXAMPLE_PAGES['product-cover']
  if (scenario === 'analysis-decision' || scenario === 'management-report') return EXAMPLE_PAGES['product-overview']
  if (scenario === 'tech-engineering') return EXAMPLE_PAGES['product-specs']
  return undefined
}
