import {
  downsample,
  kittyDeleteSequence,
  kittyGraphicsSupported,
  kittyTransmitSequence,
  rasterizePane,
  type PaletteCell,
} from './graphics.js'
import type { HitRegion } from './runtime.js'
import type { TerminalSession } from './terminal.js'
import type { AppState } from './wm.js'

const KITTY_IMAGE_ID_BASE = 8400
const MAX_SRC_COLS = 240
const MAX_SRC_ROWS = 100
const SUPERSAMPLE = 2
const FALLBACK_CELL_PX_W = 10
const FALLBACK_CELL_PX_H = 20

export const kittyExposeSupported = kittyGraphicsSupported()

export type ExposeDeps = {
  getState: () => AppState
  getHitRegions: () => HitRegion[]
  sessions: Map<string, TerminalSession>
  getCellPx: () => { w: number; h: number } | null
}

let deps: ExposeDeps | null = null
const activeKittyImageIds = new Set<number>()

function d(): ExposeDeps {
  if (!deps) throw new Error('expose-graphics not initialized')
  return deps
}

export function initExposeGraphics(init: ExposeDeps): void {
  deps = init
}

export function hasActiveExposeImages(): boolean {
  return activeKittyImageIds.size > 0
}

export function clearExposeGraphics(): string {
  let out = ''
  for (const id of activeKittyImageIds) {
    out += kittyDeleteSequence(id)
  }
  activeKittyImageIds.clear()
  return out
}

export function renderExposeGraphics(): string {
  if (!kittyExposeSupported) return ''
  const { getState, getHitRegions, sessions, getCellPx } = d()
  const state = getState()
  if (!state.expose) return clearExposeGraphics()

  const hitRegions = getHitRegions()
  const cards = hitRegions.filter(r => r.id.startsWith('expose:'))
  if (cards.length === 0) return clearExposeGraphics()

  const cellPx = getCellPx()
  const cellPxW = cellPx?.w ?? FALLBACK_CELL_PX_W
  const cellPxH = cellPx?.h ?? FALLBACK_CELL_PX_H

  const usedIds = new Set<number>()
  let out = ''
  let i = 0
  for (const card of cards) {
    const paneId = card.id.slice('expose:'.length)
    const session = sessions.get(paneId)
    if (!session) continue
    const contentRect = {
      x: card.x + 1,
      y: card.y + 2,
      width: Math.max(0, card.width - 2),
      height: Math.max(0, card.height - 3),
    }
    if (contentRect.width <= 0 || contentRect.height <= 0) continue
    const cells = session.cells as unknown as PaletteCell[][]
    const srcRows = Math.min(cells.length, MAX_SRC_ROWS)
    if (srcRows === 0) continue
    const srcCols = Math.min(cells[0]?.length ?? 0, MAX_SRC_COLS)
    if (srcCols === 0) continue
    const totalPxW = contentRect.width * cellPxW
    const totalPxH = contentRect.height * cellPxH
    const superBuf = rasterizePane({
      cells,
      cols: srcCols,
      rows: srcRows,
      totalWidthPx: totalPxW * SUPERSAMPLE,
      totalHeightPx: totalPxH * SUPERSAMPLE,
    })
    const buf = downsample(superBuf, SUPERSAMPLE)
    const imageId = KITTY_IMAGE_ID_BASE + i
    i += 1
    usedIds.add(imageId)
    out += kittyTransmitSequence({
      imageId,
      buffer: buf,
      displayCols: contentRect.width,
      displayRows: contentRect.height,
      cursorRow: contentRect.y + 1,
      cursorCol: contentRect.x + 1,
    })
  }
  for (const prevId of activeKittyImageIds) {
    if (!usedIds.has(prevId)) out += kittyDeleteSequence(prevId)
  }
  activeKittyImageIds.clear()
  for (const id of usedIds) activeKittyImageIds.add(id)
  return out
}
