import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DragBridge, samplePreview, type DragBridgeEvent } from './drag-bridge.js'
import type { TerminalSession } from './terminal.js'
import { encodeTabViewBlob } from './tab-view.js'
import {
  cancelDrag as cancelDragAction,
  collectPaneIds,
  findPane,
  findPaneInTabs,
  setStatus,
  type AppState,
} from './wm.js'

type Handoff =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; tabId: string; paneId: string; tabTitle: string }

export type DragDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  sessions: Map<string, TerminalSession>
  scheduleRender: () => void
  ejectPaneById: (paneId: string) => boolean
}

let deps: DragDeps | null = null
let bridge: DragBridge | null = null
let handoff: Handoff | null = null

function d(): DragDeps {
  if (!deps) throw new Error('drag not initialized')
  return deps
}

export function initDrag(d: DragDeps): void {
  deps = d
}

// The drag daemon is a macOS-only Swift binary (AppKit + CGEventTap). On other
// platforms we skip the spawn and no-op the start/cancel paths so the UI stays
// quiet and a drag gesture doesn't strand a handoff waiting for a daemon that
// will never reply.
const enabled = process.platform === 'darwin'

function getBridge(): DragBridge {
  if (bridge) return bridge
  bridge = new DragBridge()
  bridge.on('message', (msg: DragBridgeEvent) => onBridgeMessage(msg))
  bridge.on('disconnected', () => {
    // If the daemon dies while a drag is in flight, nothing else will ever
    // send us a drag_result. Clear local drag state so the UI doesn't freeze
    // in drag mode.
    const { getState, setState, scheduleRender } = d()
    if (handoff || getState().drag.kind !== 'none') {
      handoff = null
      setState(setStatus(cancelDragAction(getState()), 'drag daemon disconnected'))
      scheduleRender()
    }
  })
  return bridge
}

export function startDragDaemonConnect(): void {
  if (!enabled) return
  // Spin up the drag daemon eagerly so the CGEventTap is live before the
  // first drag gesture — otherwise the daemon boot (~hundreds of ms) races
  // with a quick drag and misses the mouse stream entirely.
  getBridge()
    .ensureConnected()
    .catch(err => {
      const { getState, setState, scheduleRender } = d()
      setState(setStatus(getState(), `drag daemon disabled: ${(err as Error).message}`))
      scheduleRender()
    })
}

export function closeDragBridge(): void {
  bridge?.close()
}

export function notifyDragCancelled(): void {
  if (!enabled) return
  if (!handoff) return
  // Do not clear handoff here. The daemon may have already started dropping
  // (it ignores cancels once in-flight) and will send
  // drag_result{outcome=dropped}. Clearing locally would drop that event on
  // the floor, leaving the tab/pane visible in hux after a successful drop.
  bridge?.cancel()
}

export function notifyPaneDragStart(paneId: string): void {
  if (!enabled) return
  const { getState, setState, sessions, scheduleRender } = d()
  const info = findPaneInTabs(getState(), paneId)
  if (!info) return
  const session = sessions.get(paneId)
  const preview = session ? samplePreview(session.cells) : []
  handoff = { kind: 'pane', paneId }
  const b = getBridge()
  b.startDrag({
    paneId,
    title: info.pane.title,
    accent: info.pane.accent,
    preview,
    sourcePid: process.pid,
    huxBinary: huxBinaryPath(),
  }).catch(err => {
    handoff = null
    setState(setStatus(getState(), `drag daemon unavailable: ${(err as Error).message}`))
    scheduleRender()
  })
}

export function notifyTabDragStart(tabId: string): void {
  if (!enabled) return
  const { getState, setState, sessions, scheduleRender } = d()
  const state = getState()
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) return
  const focusedId = tab.focusedPaneId
  const pane = findPane(tab.root, focusedId)
  if (!pane) return
  const session = sessions.get(focusedId)
  const preview = session ? samplePreview(session.cells) : []
  handoff = { kind: 'tab', tabId, paneId: focusedId, tabTitle: tab.title }
  const b = getBridge()
  const hux = huxBinaryPath()
  const blob = encodeTabViewBlob({
    title: tab.title,
    root: tab.root,
    focusedPaneId: tab.focusedPaneId,
  })
  b.startDrag({
    paneId: focusedId,
    title: tab.title,
    accent: pane.accent,
    preview,
    sourcePid: process.pid,
    huxBinary: hux,
    command: `${shellQuote(hux)} tab-view --layout64 ${shellQuote(blob)}`,
  }).catch(err => {
    handoff = null
    setState(setStatus(getState(), `drag daemon unavailable: ${(err as Error).message}`))
    scheduleRender()
  })
}

function onBridgeMessage(msg: DragBridgeEvent): void {
  if (msg.op === 'hello' || msg.op === 'pong') return
  const { getState, setState, scheduleRender, ejectPaneById } = d()
  if (msg.op === 'permission_denied') {
    handoff = null
    setState(
      setStatus(
        cancelDragAction(getState()),
        'grant accessibility to hux-drag-daemon in System Settings → Privacy & Security',
      ),
    )
    scheduleRender()
    return
  }
  if (msg.op !== 'drag_result') return

  const current = handoff
  handoff = null
  if (msg.outcome === 'dropped' && current) {
    let state = getState()
    if (state.drag.kind !== 'none') {
      state = { ...state, drag: { kind: 'none' } }
      setState(state)
    }
    if (current.kind === 'tab') {
      const tab = state.tabs.find(t => t.id === current.tabId)
      const paneIds = tab ? collectPaneIds(tab.root) : []
      const ordered = [current.paneId, ...paneIds.filter(id => id !== current.paneId)]
      let ejectedCount = 0
      for (const pid of ordered) {
        if (ejectPaneById(pid)) ejectedCount += 1
      }
      setState(
        setStatus(
          getState(),
          `tab "${current.tabTitle}" → Ghostty (${msg.target}); ejected ${ejectedCount} pane(s)`,
        ),
      )
    } else {
      const ejected = ejectPaneById(current.paneId)
      setState(
        setStatus(
          getState(),
          ejected
            ? `ejected ${current.paneId} → Ghostty (${msg.target})`
            : `drag landed on Ghostty (${msg.target}) but ejectPane was a no-op for ${current.paneId}`,
        ),
      )
    }
    scheduleRender()
    return
  }
  if (msg.outcome === 'cancelled') {
    setState(setStatus(getState(), 'drag cancelled by daemon'))
    scheduleRender()
    return
  }
  if (msg.outcome === 'error') {
    setState(setStatus(cancelDragAction(getState()), `drag failed: ${msg.message}`))
    scheduleRender()
  }
}

function huxBinaryPath(): string {
  const override = process.env.HUX_BIN
  if (override && existsSync(override)) return override
  // Ghostty launches the new-tab command with `bash --noprofile --norc`, so
  // the user's PATH isn't loaded. Hand Ghostty an absolute path instead.
  const exec = process.execPath
  if (exec.endsWith('/hux') && existsSync(exec)) return exec
  const cwdHux = join(process.cwd(), 'hux')
  if (existsSync(cwdHux)) return cwdHux
  return 'hux'
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
