import { kittyGraphicsSupported } from './graphics.js'
import { setHoverPeek, type AppState } from './wm.js'

const HOVER_PEEK_DELAY_MS = 450
const peekEnabled = kittyGraphicsSupported()

export type HoverPeekDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  scheduleRender: () => void
}

let deps: HoverPeekDeps | null = null
let candidateTabId: string | null = null
let timer: NodeJS.Timeout | null = null

function d(): HoverPeekDeps {
  if (!deps) throw new Error('hover-peek not initialized')
  return deps
}

export function initHoverPeek(d: HoverPeekDeps): void {
  deps = d
}

export function scheduleHoverPeek(tabId: string): void {
  if (!peekEnabled) return
  const { getState } = d()
  if (candidateTabId === tabId && timer) return
  if (getState().hoverPeek?.tabId === tabId) {
    candidateTabId = tabId
    return
  }
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  candidateTabId = tabId
  timer = setTimeout(() => {
    timer = null
    if (candidateTabId !== tabId) return
    const { getState, setState, scheduleRender } = d()
    setState(setHoverPeek(getState(), { tabId }))
    scheduleRender()
  }, HOVER_PEEK_DELAY_MS)
}

export function clearHoverPeek(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  candidateTabId = null
  const { getState, setState, scheduleRender } = d()
  if (getState().hoverPeek) {
    setState(setHoverPeek(getState(), null))
    scheduleRender()
  }
}
