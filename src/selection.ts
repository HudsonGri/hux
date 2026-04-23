import type { CellStyle } from './runtime.js'
import type { Cell as IpcCell } from './ipc.js'
import type { TerminalSession } from './terminal.js'
import { getScrollState } from './scrollback.js'
import { setStatus, type AppState } from './wm.js'

export type Selection = {
  paneId: string
  anchor: { x: number; y: number }
  cursor: { x: number; y: number }
  active: boolean
}

export type NormalizedSelection = {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export type SelectionDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  sessions: Map<string, TerminalSession>
  paneLocalCoords: (
    paneId: string,
    x: number,
    y: number,
    clamp?: boolean,
  ) => { x: number; y: number } | null
}

let deps: SelectionDeps | null = null
let selection: Selection | null = null

function d(): SelectionDeps {
  if (!deps) throw new Error('selection not initialized')
  return deps
}

export function initSelection(d: SelectionDeps): void {
  deps = d
}

export function getSelection(): Selection | null {
  return selection
}

export function clearSelection(): void {
  selection = null
}

export function hasActiveSelection(): boolean {
  return selection !== null && selection.active
}

export function startSelection(paneId: string, pt: { x: number; y: number }): void {
  selection = { paneId, anchor: { ...pt }, cursor: { ...pt }, active: true }
}

export function updateSelectionCursor(x: number, y: number): boolean {
  if (!selection?.active) return false
  const pt = d().paneLocalCoords(selection.paneId, x, y, true)
  if (pt) selection = { ...selection, cursor: pt }
  return true
}

export function releaseSelection(): boolean {
  if (!selection?.active) return false
  const { anchor, cursor } = selection
  const moved = anchor.x !== cursor.x || anchor.y !== cursor.y
  if (moved) {
    selection = { ...selection, active: false }
    copyCurrentSelection()
  } else {
    selection = null
  }
  return true
}

export function pruneSelectionForPane(focusedPaneId: string): void {
  if (selection && selection.paneId !== focusedPaneId && !selection.active) {
    selection = null
  }
}

export function selectionOverlayFor(paneId: string): NormalizedSelection | null {
  if (!selection || selection.paneId !== paneId) return null
  return normalize(selection)
}

function normalize(sel: Selection): NormalizedSelection {
  const { anchor, cursor } = sel
  if (anchor.y < cursor.y || (anchor.y === cursor.y && anchor.x <= cursor.x)) {
    return { start: anchor, end: cursor }
  }
  return { start: cursor, end: anchor }
}

function inSelection(x: number, y: number, sel: NormalizedSelection): boolean {
  if (y < sel.start.y || y > sel.end.y) return false
  if (sel.start.y === sel.end.y) return x >= sel.start.x && x <= sel.end.x
  if (y === sel.start.y) return x >= sel.start.x
  if (y === sel.end.y) return x <= sel.end.x
  return true
}

function activeGridFor(paneId: string): readonly (readonly IpcCell[])[] | null {
  const scroll = getScrollState()
  if (scroll && scroll.paneId === paneId) return scroll.grid
  const session = d().sessions.get(paneId)
  return session?.cells ?? null
}

function copyCurrentSelection(): void {
  if (!selection) return
  const sel = normalize(selection)
  const grid = activeGridFor(selection.paneId)
  if (!grid) return
  const lines: string[] = []
  for (let y = sel.start.y; y <= sel.end.y; y++) {
    const row = grid[y]
    if (!row) {
      lines.push('')
      continue
    }
    const xStart = y === sel.start.y ? sel.start.x : 0
    const xEnd = y === sel.end.y ? sel.end.x : row.length - 1
    let line = ''
    for (let x = xStart; x <= Math.min(xEnd, row.length - 1); x++) {
      const cell = row[x]
      line += cell && cell.ch !== '' ? cell.ch : ' '
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  const text = lines.join('\n').replace(/\n+$/, '')
  if (!text) return
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  process.stdout.write(`\x1b]52;c;${b64}\x07`)
  const { getState, setState } = d()
  setState(setStatus(getState(), `copied ${text.length} chars`))
}

export function paintCells(
  painter: { set: (x: number, y: number, ch: string, style?: CellStyle) => void },
  rect: { x: number; y: number; width: number; height: number },
  grid: readonly (readonly IpcCell[])[],
  sel: NormalizedSelection | null,
  highlight: { row: number; colStart: number; colEnd: number } | null = null,
): void {
  const rowCount = Math.min(grid.length, rect.height)
  for (let r = 0; r < rowCount; r++) {
    const row = grid[r]
    if (!row) continue
    const colCount = Math.min(row.length, rect.width)
    for (let c = 0; c < colCount; c++) {
      const cell = row[c]
      if (!cell) continue
      const ch = cell.ch === '' ? ' ' : cell.ch
      const style: CellStyle = {}
      if (cell.fg !== undefined) style.fg = cell.fg
      if (cell.bg !== undefined) style.bg = cell.bg
      if (cell.bold) style.bold = true
      let out = style
      if (sel && inSelection(c, r, sel)) {
        out = {
          fg: style.bg ?? 234,
          bg: style.fg ?? 250,
          bold: style.bold,
        }
      }
      if (
        highlight &&
        r === highlight.row &&
        c >= highlight.colStart &&
        c < highlight.colEnd
      ) {
        out = { fg: 234, bg: 220, bold: true }
      }
      painter.set(rect.x + c, rect.y + r, ch, out)
    }
  }
}
