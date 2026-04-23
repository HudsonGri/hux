import {
  downsample,
  kittyDeleteSequence,
  kittyGraphicsSupported,
  kittyTransmitSequence,
  rasterizePane,
  type PaletteCell,
} from './graphics.js'
import type { PaintFn, HitRegion } from './runtime.js'
import type { TerminalSession } from './terminal.js'
import { computePeekRect } from './view.js'
import {
  type AppState,
  type PaneNode,
} from './wm.js'
import { debugLogLine } from './debug-log.js'

const KITTY_IMAGE_ID_BASE = 7700
const PEEK_MAX_SRC_COLS = 240
const PEEK_MAX_SRC_ROWS = 100
const PEEK_SUPERSAMPLE = 3
const PEEK_FALLBACK_CELL_PX_W = 10
const PEEK_FALLBACK_CELL_PX_H = 20

export const kittyPeekSupported = kittyGraphicsSupported()

export type PeekDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  getHitRegions: () => HitRegion[]
  sessions: Map<string, TerminalSession>
  scheduleRender: () => void
}

let deps: PeekDeps | null = null
let terminalCellPx: { w: number; h: number } | null = null
const activeKittyImageIds = new Set<number>()

function d(): PeekDeps {
  if (!deps) throw new Error('peek-graphics not initialized')
  return deps
}

export function initPeekGraphics(d: PeekDeps): void {
  deps = d
}

export function hasActivePeekImages(): boolean {
  return activeKittyImageIds.size > 0
}

export function getTerminalCellPx(): { w: number; h: number } | null {
  return terminalCellPx
}

export function clearPeekGraphics(): string {
  let out = ''
  for (const id of activeKittyImageIds) {
    out += kittyDeleteSequence(id)
  }
  activeKittyImageIds.clear()
  return out
}

export function renderPeekGraphics(columns: number, rows: number): string {
  const { getState, getHitRegions, sessions } = d()
  const state = getState()
  if (!state.hoverPeek) return clearPeekGraphics()
  const tab = state.tabs.find(t => t.id === state.hoverPeek!.tabId)
  if (!tab) return clearPeekGraphics()
  const hitRegions = getHitRegions()
  const anchor = hitRegions.find(r => r.id === `tab:${state.hoverPeek!.tabId}`)
  if (!anchor) return clearPeekGraphics()
  const peek = computePeekRect({ x: anchor.x, width: anchor.width }, columns, rows)
  const inner = {
    x: peek.x + 1,
    y: peek.y + 3,
    width: peek.width - 2,
    height: peek.height - 4,
  }
  if (inner.width <= 0 || inner.height <= 0) return clearPeekGraphics()
  const leafRects = layoutPeekPanes(tab.root, inner)
  const usedIds = new Set<number>()
  const cellPxW = terminalCellPx?.w ?? PEEK_FALLBACK_CELL_PX_W
  const cellPxH = terminalCellPx?.h ?? PEEK_FALLBACK_CELL_PX_H
  let out = ''
  let i = 0
  for (const { paneId, rect } of leafRects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const session = sessions.get(paneId)
    if (!session) continue
    const cells = session.cells as unknown as PaletteCell[][]
    const srcRows = Math.min(cells.length, PEEK_MAX_SRC_ROWS)
    if (srcRows === 0) continue
    const srcCols = Math.min(cells[0]?.length ?? 0, PEEK_MAX_SRC_COLS)
    if (srcCols === 0) continue
    const totalPxW = rect.width * cellPxW
    const totalPxH = rect.height * cellPxH
    const superBuf = rasterizePane({
      cells,
      cols: srcCols,
      rows: srcRows,
      totalWidthPx: totalPxW * PEEK_SUPERSAMPLE,
      totalHeightPx: totalPxH * PEEK_SUPERSAMPLE,
    })
    const buf = downsample(superBuf, PEEK_SUPERSAMPLE)
    const imageId = KITTY_IMAGE_ID_BASE + i
    i += 1
    usedIds.add(imageId)
    out += kittyTransmitSequence({
      imageId,
      buffer: buf,
      displayCols: rect.width,
      displayRows: rect.height,
      cursorRow: rect.y + 1,
      cursorCol: rect.x + 1,
    })
  }
  for (const prevId of activeKittyImageIds) {
    if (!usedIds.has(prevId)) out += kittyDeleteSequence(prevId)
  }
  activeKittyImageIds.clear()
  for (const id of usedIds) activeKittyImageIds.add(id)
  return out
}

export function thumbnailForPane(paneId: string): PaintFn | null {
  const session = d().sessions.get(paneId)
  if (!session) return null
  return (painter, rect) => {
    const grid = session.cells
    const srcRows = grid.length
    if (srcRows === 0 || rect.height <= 0 || rect.width <= 0) return
    const srcCols = grid[0]?.length ?? 0
    if (srcCols === 0) return

    // Half-block minimap: each output cell is a ▀ with its top half colored
    // from one source row and its bottom half from the next. This doubles
    // our vertical resolution so the full pane can fit at a readable scale,
    // and since we paint colors rather than trying to pick representative
    // characters, the minimap stays readable instead of dissolving into
    // sampling noise. Never upscales — if the source is smaller than the
    // rect, empty space is left at the bottom.
    const scaleX = Math.max(1, srcCols / rect.width)
    const halfRowBudget = rect.height * 2
    const scaleY = Math.max(1, srcRows / halfRowBudget)
    const outCols = Math.min(rect.width, Math.ceil(srcCols / scaleX))
    const outHalfRows = Math.min(halfRowBudget, Math.ceil(srcRows / scaleY))
    const outRows = Math.ceil(outHalfRows / 2)

    const blockColor = (
      rStart: number,
      rEnd: number,
      cStart: number,
      cEnd: number,
    ): number | null => {
      if (rStart >= srcRows) return null
      let textColor: number | null = null
      let bgColor: number | null = null
      const rowEnd = Math.min(srcRows, rEnd)
      const colEnd = Math.min(srcCols, cEnd)
      for (let r = rStart; r < rowEnd; r++) {
        const row = grid[r]
        if (!row) continue
        for (let c = cStart; c < colEnd; c++) {
          const cell = row[c]
          if (!cell) continue
          const ch = cell.ch === '' ? ' ' : cell.ch
          if (ch !== ' ') {
            if (textColor === null) textColor = cell.fg ?? 250
          } else if (bgColor === null) {
            bgColor = cell.bg ?? 234
          }
        }
      }
      return textColor ?? bgColor ?? 234
    }

    for (let oy = 0; oy < outRows; oy++) {
      const topHalf = oy * 2
      const botHalf = oy * 2 + 1
      const topStart = Math.floor(topHalf * scaleY)
      const topEnd = Math.max(topStart + 1, Math.ceil((topHalf + 1) * scaleY))
      const botStart = Math.floor(botHalf * scaleY)
      const botEnd = Math.max(botStart + 1, Math.ceil((botHalf + 1) * scaleY))

      for (let ox = 0; ox < outCols; ox++) {
        const cStart = Math.floor(ox * scaleX)
        const cEnd = Math.max(cStart + 1, Math.ceil((ox + 1) * scaleX))
        const topColor = blockColor(topStart, topEnd, cStart, cEnd)
        const botColor = blockColor(botStart, botEnd, cStart, cEnd)
        if (topColor === null && botColor === null) continue
        if (botColor === null) {
          painter.set(rect.x + ox, rect.y + oy, ' ', { bg: topColor ?? 234 })
        } else {
          painter.set(rect.x + ox, rect.y + oy, '▀', {
            fg: topColor ?? botColor ?? 234,
            bg: botColor,
          })
        }
      }
    }
  }
}

export function consumeTerminalSizeResponses(input: string): string {
  let out = input
  for (;;) {
    const m = out.match(/\x1b\[(4|6);(\d+);(\d+)t/)
    if (!m) return out
    const kind = m[1]
    const a = parseInt(m[2]!, 10)
    const b = parseInt(m[3]!, 10)
    if (kind === '6' && a > 0 && b > 0) {
      terminalCellPx = { w: b, h: a }
      debugLogLine(`cell px from CSI 16 t: ${b}×${a}`)
    } else if (kind === '4' && a > 0 && b > 0 && !terminalCellPx) {
      const cols = process.stdout.columns || 120
      const rows = process.stdout.rows || 32
      const w = Math.max(1, Math.floor(b / cols))
      const h = Math.max(1, Math.floor(a / rows))
      terminalCellPx = { w, h }
      debugLogLine(`cell px from CSI 14 t: win ${b}×${a}, cell ~${w}×${h}`)
    }
    out = out.slice(0, m.index!) + out.slice(m.index! + m[0].length)
  }
}

type PeekPaneRect = {
  paneId: string
  rect: { x: number; y: number; width: number; height: number }
}

function layoutPeekPanes(
  node: PaneNode,
  rect: { x: number; y: number; width: number; height: number },
): PeekPaneRect[] {
  if (rect.width <= 0 || rect.height <= 0) return []
  if (node.kind === 'leaf') return [{ paneId: node.id, rect }]
  if (node.orientation === 'row') {
    const avail = Math.max(0, rect.width - 1)
    const leftGrow = Math.max(1, Math.round(node.ratio * 100))
    const rightGrow = Math.max(1, 100 - leftGrow)
    const total = leftGrow + rightGrow
    const leftW = Math.max(0, Math.floor((avail * leftGrow) / total))
    const rightW = Math.max(0, avail - leftW)
    return [
      ...layoutPeekPanes(node.children[0], {
        x: rect.x,
        y: rect.y,
        width: leftW,
        height: rect.height,
      }),
      ...layoutPeekPanes(node.children[1], {
        x: rect.x + leftW + 1,
        y: rect.y,
        width: rightW,
        height: rect.height,
      }),
    ]
  }
  const avail = Math.max(0, rect.height - 1)
  const topGrow = Math.max(1, Math.round(node.ratio * 100))
  const botGrow = Math.max(1, 100 - topGrow)
  const total = topGrow + botGrow
  const topH = Math.max(0, Math.floor((avail * topGrow) / total))
  const botH = Math.max(0, avail - topH)
  return [
    ...layoutPeekPanes(node.children[0], {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: topH,
    }),
    ...layoutPeekPanes(node.children[1], {
      x: rect.x,
      y: rect.y + topH + 1,
      width: rect.width,
      height: botH,
    }),
  ]
}
