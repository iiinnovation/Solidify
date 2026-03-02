// 8 种布局类型
export type SlideLayout =
  | 'title'           // 标题页：大标题 + 副标题
  | 'content'         // 标准内容：标题 + 正文（支持 bullet list）
  | 'two-column'      // 双栏：标题 + 左右两栏内容
  | 'image-text'      // 图文：标题 + 图片占位 + 文字说明
  | 'comparison'      // 对比：标题 + 左右对比（各有小标题+内容）
  | 'stats'           // 数据统计：标题 + 多个数字指标卡片
  | 'timeline'        // 时间线：标题 + 时间节点列表
  | 'section'         // 章节分隔页：大标题居中

export interface SlideItem {
  layout: SlideLayout
  title?: string
  subtitle?: string
  body?: string | string[]       // content 布局的正文/bullet
  left?: string | string[]       // two-column / comparison 左栏
  right?: string | string[]      // two-column / comparison 右栏
  leftTitle?: string             // comparison 左标题
  rightTitle?: string            // comparison 右标题
  image?: string                 // image-text 的图片描述（占位）
  stats?: { label: string; value: string }[]  // stats 布局
  items?: { time: string; text: string }[]    // timeline 布局
  notes?: string                 // 演讲备注
}

export interface SlidesDeck {
  slides: SlideItem[]
  theme?: string                 // 主题 ID（Phase 2 使用）
}

/** 去除 AI 可能包裹的 markdown 代码围栏 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fenceRegex = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/
  const match = trimmed.match(fenceRegex)
  return match ? match[1].trim() : trimmed
}

/** 解析 AI 输出的 slides JSON，返回 SlidesDeck 或 null */
export function parseSlidesDeck(raw: string): SlidesDeck | null {
  try {
    const cleaned = stripCodeFences(raw)
    const parsed = JSON.parse(cleaned)
    if (!parsed || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      return null
    }
    return parsed as SlidesDeck
  } catch {
    return null
  }
}
