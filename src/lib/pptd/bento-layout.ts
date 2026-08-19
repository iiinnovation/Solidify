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
  const normalized = unique.length > 0 ? unique : fallbackPlanningCards(page)
  return {
    pageIndex,
    pageType: page.pageType,
    layoutType: draft.layoutType === 'flow' || draft.layoutType === 'hero' || draft.layoutType === 'split' ? draft.layoutType : 'bento',
    cards: normalized,
  }
}

export function fallbackPlanningDraft(page: DeckOutlinePage, pageIndex: number): PptdPlanningDraft {
  return { pageIndex, pageType: page.pageType, layoutType: 'bento', cards: fallbackPlanningCards(page) }
}

function fallbackPlanningCards(page: DeckOutlinePage): PptdPlanningCard[] {
  const cards: PptdPlanningCard[] = [{
    id: 'main-conclusion',
    grid: { col: 0, row: 0, colSpan: 8, rowSpan: 3 },
    type: 'text',
    priority: 'primary',
    content: { text: page.intent },
  }]
  page.keyPoints.slice(0, 3).forEach((point, index) => cards.push({
    id: `evidence-${index + 1}`,
    grid: { col: index * 4, row: 3, colSpan: 4, rowSpan: 3 },
    type: 'text',
    priority: 'secondary',
    content: { text: point },
  }))
  return cards
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
