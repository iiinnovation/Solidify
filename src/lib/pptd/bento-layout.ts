import type { DeckOutlinePage } from './pipeline'
import type { PptdPlanningDraft, PptdPlanningCard } from './planning'

export const BENTO_GRID_COLUMNS = 12
export const BENTO_GRID_ROWS = 6

export interface BentoBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BentoLayoutOptions {
  width?: number
  height?: number
  margin?: number
  gutter?: number
}

/** Converts the semantic 12x6 planning grid into stable page bounds. */
export function bentoGridToBounds(
  grid: PptdPlanningCard['grid'],
  options: BentoLayoutOptions = {},
): BentoBounds {
  const width = options.width ?? 960
  const height = options.height ?? 540
  const margin = options.margin ?? 48
  const gutter = options.gutter ?? 16
  const cellWidth = (width - margin * 2 - gutter * (BENTO_GRID_COLUMNS - 1)) / BENTO_GRID_COLUMNS
  const cellHeight = (height - margin * 2 - gutter * (BENTO_GRID_ROWS - 1)) / BENTO_GRID_ROWS
  const col = clampInteger(grid.col, 0, BENTO_GRID_COLUMNS - 1)
  const row = clampInteger(grid.row, 0, BENTO_GRID_ROWS - 1)
  const colSpan = clampInteger(grid.colSpan, 1, BENTO_GRID_COLUMNS - col)
  const rowSpan = clampInteger(grid.rowSpan, 1, BENTO_GRID_ROWS - row)
  return {
    x: Math.round(margin + col * (cellWidth + gutter)),
    y: Math.round(margin + row * (cellHeight + gutter)),
    width: Math.round(cellWidth * colSpan + gutter * (colSpan - 1)),
    height: Math.round(cellHeight * rowSpan + gutter * (rowSpan - 1)),
  }
}

/**
 * Normalizes model-authored cards into a non-overlapping grid. The model still
 * chooses the composition; this function only removes impossible geometry.
 */
export function normalizePlanningDraft(
  draft: PptdPlanningDraft,
  page: DeckOutlinePage,
  pageIndex: number,
): PptdPlanningDraft {
  const usedIds = new Set<string>()
  const cards = draft.cards.slice(0, 6).map((card, index) => ({
    ...card,
    id: uniqueId(safeId(card.id, `card-${index + 1}`), usedIds),
    grid: clampGrid(card.grid),
  }))
  const unique: PptdPlanningCard[] = []
  for (const card of cards) {
    const candidate = findAvailableGrid(card.grid, unique)
    if (candidate) unique.push({ ...card, grid: candidate })
  }
  const normalized = unique.length > 0 ? unique : fallbackPlanningCards(page, pageIndex)
  return {
    pageIndex,
    pageType: page.pageType,
    layoutType: draft.layoutType === 'flow' || draft.layoutType === 'hero' || draft.layoutType === 'split' ? draft.layoutType : 'bento',
    cards: normalized,
  }
}

export function fallbackPlanningDraft(
  page: DeckOutlinePage,
  pageIndex: number,
  options: { hasMedia?: boolean } = {},
): PptdPlanningDraft {
  return {
    pageIndex,
    pageType: page.pageType,
    layoutType: fallbackLayoutType(page, options.hasMedia === true),
    cards: fallbackPlanningCards(page, pageIndex, options.hasMedia === true),
  }
}

function fallbackPlanningCards(page: DeckOutlinePage, pageIndex: number, hasMedia = false): PptdPlanningCard[] {
  const pageType = page.pageType.toLowerCase()
  const pageText = [pageType, page.intent, page.layout, page.visualTask, page.assetBrief, ...page.keyPoints].join(' ').toLowerCase()
  const points = page.keyPoints.length > 0 ? page.keyPoints : [page.intent]
  const content = (items: readonly string[]) => ({ text: items.filter(Boolean).join('\n') })
  const card = (
    id: string,
    grid: PptdPlanningCard['grid'],
    type: PptdPlanningCard['type'],
    priority: PptdPlanningCard['priority'],
    text: Record<string, unknown>,
  ): PptdPlanningCard => ({ id, grid, type, priority, content: text })

  if (pageType === 'cover' || pageType === 'section') {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 4 }, 'text', 'primary', { text: page.intent }),
      card('context-line', { col: 0, row: 4, colSpan: 8, rowSpan: 2 }, 'text', 'secondary', content(points.slice(0, 2))),
    ]
  }
  if (isDiagramPage(pageText)) {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 1 }, 'text', 'primary', { text: page.intent }),
      card('system-diagram', { col: 0, row: 1, colSpan: 9, rowSpan: 5 }, 'diagram', 'primary', {
        text: points.join('\n'),
        visualTask: page.visualTask ?? page.layout ?? '按层级与方向表达关系',
      }),
      card('diagram-legend', { col: 9, row: 1, colSpan: 3, rowSpan: 5 }, 'text', 'secondary', content(points.slice(0, 3))),
    ]
  }
  if (/chart|图表|趋势|分布|占比|kpi|metric/.test(pageText) && hasChartEvidence(page)) {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 1 }, 'text', 'primary', { text: page.intent }),
      card('primary-chart', { col: 0, row: 1, colSpan: 8, rowSpan: 5 }, 'chart', 'primary', { text: page.dataHint ?? points[0] }),
      card('chart-evidence', { col: 8, row: 1, colSpan: 4, rowSpan: 5 }, 'data', 'secondary', content(points.slice(0, 4))),
    ]
  }
  if (pageType === 'table' || /表格|清单|矩阵|matrix/.test(pageText)) {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 1 }, 'text', 'primary', { text: page.intent }),
      card('evidence-table', { col: 0, row: 1, colSpan: 12, rowSpan: 4 }, 'data', 'primary', content(points)),
      card('table-note', { col: 0, row: 5, colSpan: 8, rowSpan: 1 }, 'text', 'tertiary', { text: page.dataHint ?? '口径、来源与结论' }),
    ]
  }
  if (pageType === 'comparison' || /对比|对照|方案一|方案二|versus|\bvs\b/.test(pageText)) {
    const split = Math.max(1, Math.ceil(points.length / 2))
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 1 }, 'text', 'primary', { text: page.intent }),
      card('comparison-left', { col: 0, row: 1, colSpan: 6, rowSpan: 5 }, 'data', 'secondary', content(points.slice(0, split))),
      card('comparison-right', { col: 6, row: 1, colSpan: 6, rowSpan: 5 }, 'data', 'secondary', content(points.slice(split))),
    ]
  }
  if (hasMedia && (page.assetBrief || /image|photo|screenshot|图片|照片|截图|影像/.test(pageText))) {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 1 }, 'text', 'primary', { text: page.intent }),
      card('narrative', { col: 0, row: 1, colSpan: 5, rowSpan: 5 }, 'text', 'secondary', content(points)),
      card('primary-image', { col: 5, row: 1, colSpan: 7, rowSpan: 5 }, 'image', 'primary', { text: page.assetBrief ?? page.visualTask ?? page.intent }),
    ]
  }
  if (pageType === 'summary') {
    return [
      card('main-conclusion', { col: 0, row: 0, colSpan: 12, rowSpan: 2 }, 'text', 'primary', { text: page.intent }),
      card('recommended-actions', { col: 0, row: 2, colSpan: 7, rowSpan: 4 }, 'text', 'primary', content(points.slice(0, 3))),
      card('decision-request', { col: 7, row: 2, colSpan: 5, rowSpan: 4 }, 'data', 'secondary', content(points.slice(3).length > 0 ? points.slice(3) : points.slice(-1))),
    ]
  }

  const reverse = pageIndex % 2 === 1
  return [
    card('main-conclusion', { col: 0, row: 0, colSpan: reverse ? 7 : 8, rowSpan: 2 }, 'text', 'primary', { text: page.intent }),
    card('key-evidence', { col: reverse ? 7 : 8, row: 0, colSpan: reverse ? 5 : 4, rowSpan: 2 }, page.dataHint ? 'data' : 'text', 'secondary', { text: page.dataHint ?? points[0] }),
    card('evidence-body', { col: reverse ? 5 : 0, row: 2, colSpan: 7, rowSpan: 4 }, page.dataHint ? 'data' : 'text', 'primary', content(points.slice(0, 3))),
    card('supporting-context', { col: reverse ? 0 : 7, row: 2, colSpan: 5, rowSpan: 4 }, 'text', 'tertiary', content(points.slice(3).length > 0 ? points.slice(3) : points.slice(-1))),
  ]
}

function fallbackLayoutType(page: DeckOutlinePage, hasMedia: boolean): PptdPlanningDraft['layoutType'] {
  const value = [page.pageType, page.intent, page.layout, page.visualTask].join(' ').toLowerCase()
  if (page.pageType === 'cover' || page.pageType === 'section') return 'hero'
  if (isDiagramPage(value)) return 'flow'
  if (page.pageType === 'comparison' || (hasMedia && (page.assetBrief || /image|photo|图片|截图/.test(value)))) return 'split'
  return 'bento'
}

function isDiagramPage(value: string): boolean {
  return /diagram|flow|process|architecture|dependency|pipeline|workflow|架构|流程|依赖|链路|组件映射|系统关系|数据流/.test(value)
}

function hasChartEvidence(page: DeckOutlinePage): boolean {
  const values = [page.dataHint ?? '', ...page.keyPoints].join(' ')
  return (values.match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:%|[A-Za-z\u4e00-\u9fff]+)?/g) ?? []).length >= 2
}

function clampGrid(grid: PptdPlanningCard['grid']): PptdPlanningCard['grid'] {
  const col = clampInteger(grid?.col, 0, BENTO_GRID_COLUMNS - 1)
  const row = clampInteger(grid?.row, 0, BENTO_GRID_ROWS - 1)
  return {
    col,
    row,
    colSpan: clampInteger(grid?.colSpan, 1, BENTO_GRID_COLUMNS - col),
    rowSpan: clampInteger(grid?.rowSpan, 1, BENTO_GRID_ROWS - row),
  }
}

function findAvailableGrid(
  requested: PptdPlanningCard['grid'],
  occupied: readonly PptdPlanningCard[],
): PptdPlanningCard['grid'] | undefined {
  const candidates: PptdPlanningCard['grid'][] = [requested]
  for (let row = 0; row < BENTO_GRID_ROWS; row++) {
    for (let col = 0; col < BENTO_GRID_COLUMNS; col++) {
      for (let rowSpan = Math.min(requested.rowSpan, BENTO_GRID_ROWS - row); rowSpan >= 1; rowSpan--) {
        for (let colSpan = Math.min(requested.colSpan, BENTO_GRID_COLUMNS - col); colSpan >= 1; colSpan--) {
          candidates.push({ col, row, colSpan, rowSpan })
        }
      }
    }
  }
  return candidates.find((candidate) => !occupied.some((item) => gridsOverlap(item.grid, candidate)))
}

function gridsOverlap(a: PptdPlanningCard['grid'], b: PptdPlanningCard['grid']): boolean {
  return a.col < b.col + b.colSpan && a.col + a.colSpan > b.col
    && a.row < b.row + b.rowSpan && a.row + a.rowSpan > b.row
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : min
  return Math.max(min, Math.min(max, numberValue))
}

function safeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) : fallback
}

function uniqueId(requested: string, used: Set<string>): string {
  let value = requested
  let suffix = 2
  while (used.has(value)) value = `${requested}-${suffix++}`
  used.add(value)
  return value
}
