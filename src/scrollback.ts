import type { IpcClient } from './ipc-client.js'
import type { Cell as IpcCell } from './ipc.js'
import type { Pane } from './wm.js'

export type ScrollState = {
  paneId: string
  offset: number
  grid: IpcCell[][]
  rows: number
  cols: number
}

export type ScrollbackDeps = {
  getIpc: () => IpcClient
  focusedPane: () => Pane | null
  scheduleRender: () => void
}

let deps: ScrollbackDeps | null = null
let scrollState: ScrollState | null = null

function d(): ScrollbackDeps {
  if (!deps) throw new Error('scrollback not initialized')
  return deps
}

export function initScrollback(d: ScrollbackDeps): void {
  deps = d
}

export function getScrollState(): ScrollState | null {
  return scrollState
}

export function setScrollState(s: ScrollState | null): void {
  scrollState = s
}

export function scrollPageSize(): number {
  const rows = process.stdout.rows || 32
  return Math.max(1, rows - 4)
}

export async function scrollPane(paneId: string, delta: number): Promise<void> {
  const current = scrollState && scrollState.paneId === paneId ? scrollState.offset : 0
  const target = Math.max(0, current + delta)
  if (target === 0) {
    if (scrollState) {
      scrollState = null
      d().scheduleRender()
    }
    return
  }
  try {
    const grid = await d().getIpc().getScrollback(paneId, target)
    if (grid.offset === 0) {
      scrollState = null
    } else {
      scrollState = {
        paneId,
        offset: grid.offset,
        grid: grid.cells,
        rows: grid.rows,
        cols: grid.cols,
      }
    }
    d().scheduleRender()
  } catch {}
}

export function scrollFocusedPaneBy(delta: number): void {
  const pane = d().focusedPane()
  if (!pane) return
  if (scrollState && scrollState.paneId !== pane.id) scrollState = null
  void scrollPane(pane.id, delta)
}
