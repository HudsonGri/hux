import type { IpcClient } from './ipc-client.js'
import type { TerminalSession } from './terminal.js'
import { setStatus, type AppState, type Pane } from './wm.js'
import { getScrollState, setScrollState } from './scrollback.js'

export type SearchMatch = {
  line: number
  colStart: number
  colEnd: number
}

export type SearchState = {
  paneId: string
  query: string
  phase: 'input' | 'results'
  lines: string[]
  matches: SearchMatch[]
  currentIndex: number
  totalLines: number
  rows: number
}

export type SearchDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  getIpc: () => IpcClient
  sessions: Map<string, TerminalSession>
  focusedPane: () => Pane | null
  scheduleRender: () => void
}

let deps: SearchDeps | null = null
let searchState: SearchState | null = null

function d(): SearchDeps {
  if (!deps) throw new Error('search module not initialized')
  return deps
}

export function initSearch(d: SearchDeps): void {
  deps = d
}

export function getSearchState(): SearchState | null {
  return searchState
}

export function isSearching(): boolean {
  return searchState !== null
}

export async function enterSearch(): Promise<void> {
  const { focusedPane, getState, setState, scheduleRender } = d()
  const pane = focusedPane()
  if (!pane) return
  searchState = {
    paneId: pane.id,
    query: '',
    phase: 'input',
    lines: [],
    matches: [],
    currentIndex: 0,
    totalLines: 0,
    rows: 0,
  }
  setState(setStatus(getState(), '/'))
  scheduleRender()
}

export function exitSearch(): void {
  const { getState, setState, scheduleRender } = d()
  searchState = null
  setScrollState(null)
  setState(setStatus(getState(), ''))
  scheduleRender()
}

async function commitSearch(): Promise<void> {
  if (!searchState || searchState.query.length === 0) {
    exitSearch()
    return
  }
  const { sessions, getIpc, getState, setState, scheduleRender } = d()
  const paneId = searchState.paneId
  const session = sessions.get(paneId)
  if (!session) {
    exitSearch()
    return
  }
  let resp: { lines: string[] }
  try {
    resp = await getIpc().getScrollbackText(paneId)
  } catch {
    setState(setStatus(getState(), 'search: failed to fetch scrollback'))
    searchState = null
    scheduleRender()
    return
  }
  const lines = resp.lines
  const query = searchState.query.toLowerCase()
  const matches: SearchMatch[] = []
  for (let i = 0; i < lines.length; i++) {
    const hay = lines[i]!.toLowerCase()
    let from = 0
    while (true) {
      const hit = hay.indexOf(query, from)
      if (hit < 0) break
      matches.push({ line: i, colStart: hit, colEnd: hit + query.length })
      from = hit + Math.max(1, query.length)
    }
  }
  if (matches.length === 0) {
    setState(setStatus(getState(), `/${searchState.query}  (no matches)`))
    searchState = null
    scheduleRender()
    return
  }
  const { rows } = session.dimensions
  searchState = {
    ...searchState,
    phase: 'results',
    lines,
    matches,
    currentIndex: matches.length - 1,
    totalLines: lines.length,
    rows,
  }
  await jumpToCurrentMatch()
}

async function jumpToCurrentMatch(): Promise<void> {
  if (!searchState || searchState.phase !== 'results') return
  const { getIpc, getState, setState, scheduleRender } = d()
  const m = searchState.matches[searchState.currentIndex]
  if (!m) return
  const total = searchState.totalLines
  const rows = searchState.rows
  const maxOffset = Math.max(0, total - rows)
  const desired = total - Math.floor(rows / 2) - m.line
  const offset = Math.max(0, Math.min(maxOffset, desired))
  if (offset === 0) {
    setScrollState(null)
  } else {
    try {
      const grid = await getIpc().getScrollback(searchState.paneId, offset)
      setScrollState({
        paneId: searchState.paneId,
        offset: grid.offset,
        grid: grid.cells,
        rows: grid.rows,
        cols: grid.cols,
      })
    } catch {}
  }
  setState(
    setStatus(
      getState(),
      `/${searchState.query}  (${searchState.currentIndex + 1}/${searchState.matches.length})`,
    ),
  )
  scheduleRender()
}

function cycleSearchMatch(delta: 1 | -1): void {
  if (!searchState || searchState.phase !== 'results') return
  const n = searchState.matches.length
  searchState = {
    ...searchState,
    currentIndex: (searchState.currentIndex + delta + n) % n,
  }
  void jumpToCurrentMatch()
}

export function searchHighlightFor(paneId: string): {
  row: number
  colStart: number
  colEnd: number
} | null {
  if (!searchState || searchState.phase !== 'results') return null
  if (searchState.paneId !== paneId) return null
  const m = searchState.matches[searchState.currentIndex]
  if (!m) return null
  const scrollState = getScrollState()
  const offset = scrollState?.paneId === paneId ? scrollState.offset : 0
  const total = searchState.totalLines
  const rows = searchState.rows
  const topLine = total - rows - offset
  const row = m.line - topLine
  if (row < 0 || row >= rows) return null
  return { row, colStart: m.colStart, colEnd: m.colEnd }
}

export function consumeSearchKey(input: string): number {
  if (!searchState) return 0
  const { getState, setState } = d()
  if (searchState.phase === 'input') {
    const first = input[0]!
    if (first === '\r' || first === '\n') {
      void commitSearch()
      return 1
    }
    if (first === '\x1b') {
      const esc = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
      if (esc) return esc[0].length
      exitSearch()
      return 1
    }
    if (first === '\x7f' || first === '\x08') {
      if (searchState.query.length === 0) {
        exitSearch()
        return 1
      }
      const chars = Array.from(searchState.query)
      chars.pop()
      searchState = { ...searchState, query: chars.join('') }
      setState(setStatus(getState(), `/${searchState.query}`))
      return 1
    }
    if (first === '\x15') {
      searchState = { ...searchState, query: '' }
      setState(setStatus(getState(), '/'))
      return 1
    }
    const code = first.charCodeAt(0)
    if (code < 0x20) return 1
    const char = Array.from(input)[0]!
    searchState = { ...searchState, query: searchState.query + char }
    setState(setStatus(getState(), `/${searchState.query}`))
    return char.length
  }
  const first = input[0]!
  if (first === '\x1b') {
    const esc = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
    if (esc) return esc[0].length
    exitSearch()
    return 1
  }
  if (first === 'n') {
    cycleSearchMatch(-1)
    return 1
  }
  if (first === 'N') {
    cycleSearchMatch(1)
    return 1
  }
  if (first === '\r' || first === '\n') {
    cycleSearchMatch(-1)
    return 1
  }
  if (first === '/') {
    void enterSearch()
    return 1
  }
  exitSearch()
  return 0
}
