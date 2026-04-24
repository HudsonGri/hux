import { renderView, type HitRegion, type PaintFn } from './runtime.js'
import {
  buildView,
  contextMenuItemsFor,
  type DropPreview,
} from './view.js'
import {
  activeTab,
  appendTabRename,
  backspaceTabRename,
  cancelDrag,
  cancelTabRename,
  clearTabRenameBuffer,
  closeActivePane,
  closeContextMenu,
  closePane,
  collectPaneIds,
  commitTabRename,
  createInitialState,
  cycleFocusedPane,
  ejectPane,
  endDrag,
  exitExpose,
  findPaneInTabs,
  focusNextTab,
  focusPane,
  focusTab,
  moveContextMenuCursor,
  newTab,
  openContextMenu,
  pruneReservedPanes,
  recordHistory,
  redoLayout,
  releaseReservedPane,
  reopenLastClosedPane,
  setMode,
  setPaneTitle,
  setStatus,
  splitActivePane,
  startPaneDrag,
  startResizeDrag,
  startTabDrag,
  startTabRename,
  toggleExpose,
  toggleSynchronize,
  toggleZoom,
  undoLayout,
  updateDrag,
  type AppState,
  type ContextMenuState,
  type DropTarget,
  type Pane,
  type SplitDirection,
} from './wm.js'
import { TerminalSession } from './terminal.js'
import { IpcClient } from './ipc-client.js'
import { PATHS } from './ipc.js'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  CLEAR_SCREEN,
  enableMouse,
  disableMouse,
  resetPointer,
} from './terminal-escapes.js'
import { beginFrame, endFrame } from './frame-writer.js'
import { probeTerminalCaps } from './terminal-probe.js'
import { debugLogInput, debugLogLine } from './debug-log.js'
import {
  connectToServer,
  ensureRuntimeDir,
  runKillServer,
} from './boot.js'
import {
  pendingUpdateNotice,
  runUpdate,
  startupUpdateCheck,
} from './update.js'
import { VERSION } from './version.js'
import { needsWelcome, showWelcome } from './welcome.js'
import {
  consumeSearchKey,
  enterSearch,
  initSearch,
  isSearching,
  searchHighlightFor,
} from './search.js'
import {
  clearPeekGraphics,
  consumeTerminalSizeResponses,
  getTerminalCellPx,
  hasActivePeekImages,
  initPeekGraphics,
  kittyPeekSupported,
  renderPeekGraphics,
  thumbnailForPane,
} from './peek-graphics.js'
import {
  clearExposeGraphics,
  hasActiveExposeImages,
  initExposeGraphics,
  kittyExposeSupported,
  renderExposeGraphics,
} from './expose-graphics.js'
import { consumeMouseSequence, type MouseEvent } from './mouse.js'
import { initPointerShape, updatePointerShape } from './pointer-shape.js'
import { clearHoverPeek, initHoverPeek, scheduleHoverPeek } from './hover-peek.js'
import {
  getScrollState,
  initScrollback,
  scrollFocusedPaneBy,
  scrollPageSize,
  scrollPane,
  setScrollState,
} from './scrollback.js'
import {
  clearSelection,
  getSelection,
  hasActiveSelection,
  initSelection,
  paintCells,
  pruneSelectionForPane,
  releaseSelection,
  selectionOverlayFor,
  startSelection,
  updateSelectionCursor,
} from './selection.js'
import {
  closeDragBridge,
  initDrag,
  notifyDragCancelled,
  notifyPaneDragStart,
  notifyTabDragStart,
  startDragDaemonConnect,
} from './drag.js'
import {
  appendSessionRename,
  backspaceSessionRename,
  cancelSessionRename,
  clearSessionRename,
  commitSessionRename,
  consumePickerKey,
  initSessionUi,
  openSessionPicker,
  startSessionRename,
} from './session-ui.js'

const isSnapshot =
  process.argv.includes('--print') || process.argv.includes('--snapshot')
const useColor = process.stdout.isTTY && !isSnapshot && !process.env.NO_COLOR

const argv = process.argv.slice(2)

try {
  mkdirSync(PATHS.dir, { recursive: true })
  appendFileSync(
    join(PATHS.dir, 'boot.log'),
    `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`,
  )
} catch {}

const isKillServer = argv.includes('kill-server')
if (isKillServer) {
  await runKillServer()
  process.exit(0)
}

if (argv[0] === 'update') {
  try {
    await runUpdate()
    process.exit(0)
  } catch (err) {
    process.stderr.write(`hux update: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`hux ${VERSION}\n`)
  process.exit(0)
}

const paneViewIdx = argv.indexOf('pane-view')
if (paneViewIdx >= 0) {
  const paneId = argv[paneViewIdx + 1]
  if (!paneId) {
    console.error('usage: hux pane-view <pane-id>')
    process.exit(2)
  }
  const { runPaneView } = await import('./pane-view.js')
  try {
    await runPaneView(paneId)
    process.exit(0)
  } catch (err) {
    // pane-view installs its own `process.on('exit')` cleanup, so calling
    // process.exit here is sufficient to restore the terminal.
    process.stderr.write(`hux pane-view: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

const tabViewIdx = argv.indexOf('tab-view')
if (tabViewIdx >= 0) {
  const layoutFlag = argv.indexOf('--layout64', tabViewIdx + 1)
  const blob = layoutFlag >= 0 ? argv[layoutFlag + 1] : undefined
  if (!blob) {
    console.error('usage: hux tab-view --layout64 <b64>')
    process.exit(2)
  }
  const { runTabView } = await import('./tab-view.js')
  try {
    await runTabView(blob)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`hux tab-view: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

function flagValue(flags: readonly string[]): string | undefined {
  for (const flag of flags) {
    const idx = argv.indexOf(flag)
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  }
  return undefined
}

function validateSessionName(name: string): string | null {
  if (!name) return 'session name must be non-empty'
  if (name.length > 64) return 'session name too long (max 64)'
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(name)) {
    return 'session name must start with alnum/._- and contain only alnum/._- and spaces'
  }
  return null
}

if (argv.includes('ls') || argv.includes('list-sessions')) {
  const { runListSessions } = await import('./session-cli.js')
  try {
    await runListSessions()
    process.exit(0)
  } catch (err) {
    process.stderr.write(`hux ls: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

const killSessionIdx = argv.indexOf('kill-session')
if (killSessionIdx >= 0) {
  const name = flagValue(['-t', '--target'])
  if (!name) {
    console.error('usage: hux kill-session -t <name>')
    process.exit(2)
  }
  const { runKillSession } = await import('./session-cli.js')
  try {
    await runKillSession(name)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`hux kill-session: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

const renameSessionIdx = argv.indexOf('rename-session')
if (renameSessionIdx >= 0) {
  const from = argv[renameSessionIdx + 1]
  const to = argv[renameSessionIdx + 2]
  if (!from || !to) {
    console.error('usage: hux rename-session <from> <to>')
    process.exit(2)
  }
  const toErr = validateSessionName(to)
  if (toErr) {
    console.error(`hux rename-session: ${toErr}`)
    process.exit(2)
  }
  const { runRenameSession } = await import('./session-cli.js')
  try {
    await runRenameSession(from, to)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`hux rename-session: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// Figure out the session name + attach mode for the interactive flow.
// `hux` (no subcommand)           → attach "default", create if missing
// `hux attach -t <name>`          → attach existing; fail if missing
// `hux new-session -s <name>`     → create + attach
// `hux -t <name>`                 → shorthand for `attach -t <name>`
const isAttachSubcommand = argv.includes('attach')
const isNewSessionSubcommand = argv.includes('new-session') || argv.includes('new')

let sessionName = 'default'
let sessionMustExist = false
let sessionMustBeNew = false

if (isNewSessionSubcommand) {
  const name = flagValue(['-s', '--session', '-t', '--target'])
  if (!name) {
    console.error('usage: hux new-session -s <name>')
    process.exit(2)
  }
  const err = validateSessionName(name)
  if (err) {
    console.error(`hux new-session: ${err}`)
    process.exit(2)
  }
  sessionName = name
  sessionMustBeNew = true
} else if (isAttachSubcommand) {
  const name = flagValue(['-t', '--target'])
  if (!name) {
    console.error('usage: hux attach -t <name>')
    process.exit(2)
  }
  sessionName = name
  sessionMustExist = true
} else {
  const explicit = flagValue(['-t', '--target'])
  if (explicit) {
    const err = validateSessionName(explicit)
    if (err) {
      console.error(`hux: ${err}`)
      process.exit(2)
    }
    sessionName = explicit
    sessionMustExist = true
  }
}


const initialCwd = process.cwd()
const shellPath = process.env.SHELL || '/bin/bash'
const shellArgs = interactiveShellArgs(shellPath)

if (isSnapshot || !process.stdout.isTTY || !process.stdin.isTTY) {
  const columns = process.stdout.columns || 120
  const rows = process.stdout.rows || 32
  const state = createInitialState()
  const view = buildView(state, columns, rows)
  const { output } = renderView(view.root, columns, rows, {
    color: false,
    overlays: view.overlays,
  })
  process.stdout.write(`${output}\n`)
  process.exit(0)
}

let state: AppState = createInitialState()
let currentSessionName = sessionName
let cleanedUp = false
let hitRegions: HitRegion[] = []
const sessions = new Map<string, TerminalSession>()
let renderScheduled = false
let lastTabClick: { tabId: string; at: number } | null = null
const DOUBLE_CLICK_MS = 400
let ipc: IpcClient
let stateVersion = 0
let persistScheduled = false
const activityPanes = new Set<string>()
let pendingInput = ''
let mouseForwardPane: string | null = null
let historyLocked = false
let tearingDown = false
const WHEEL_LINES = 3


try {
  await main()
} catch (err) {
  // Without this guard, an uncaught rejection exits the process with the
  // terminal still in alt-screen / raw mode and no useful error line.
  cleanupTerminal()
  process.stderr.write(`hux: fatal: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  ensureRuntimeDir()
  startupUpdateCheck()
  if (needsWelcome()) {
    await showWelcome()
  }
  ipc = await connectToServer()
  initScrollback({
    getIpc: () => ipc,
    focusedPane,
    scheduleRender,
  })
  initSearch({
    getState: () => state,
    setState: s => { state = s },
    getIpc: () => ipc,
    sessions,
    focusedPane,
    scheduleRender,
  })
  initPeekGraphics({
    getState: () => state,
    setState: s => { state = s },
    getHitRegions: () => hitRegions,
    sessions,
    scheduleRender,
  })
  initExposeGraphics({
    getState: () => state,
    getHitRegions: () => hitRegions,
    sessions,
    getCellPx: getTerminalCellPx,
  })
  initSelection({
    getState: () => state,
    setState: s => { state = s },
    sessions,
    paneLocalCoords,
  })
  initHoverPeek({
    getState: () => state,
    setState: s => { state = s },
    scheduleRender,
  })
  initPointerShape({
    getState: () => state,
    findRegion,
    write: seq => process.stdout.write(seq),
  })
  initDrag({
    getState: () => state,
    setState: s => { state = s },
    sessions,
    scheduleRender,
    ejectPaneById,
  })
  initSessionUi({
    getState: () => state,
    setState: s => { state = s },
    sessions,
    getIpc: () => ipc,
    getCurrentSession: () => currentSessionName,
    setCurrentSession: name => { currentSessionName = name },
    attachSessionInPlace,
    scheduleRender,
    schedulePersist,
  })
  ipc.on('pane_exit', (ev: unknown) => {
    const { pane_id } = ev as { pane_id: string }
    if (!state.reservedPanes.includes(pane_id)) return
    state = releaseReservedPane(state, pane_id)
    ipc.closePane(pane_id).catch(() => {})
    schedulePersist()
  })
  ipc.on('notification', (ev: unknown) => {
    const { pane_id, body } = ev as { pane_id: string; body: string }
    forwardNotification(pane_id, body)
  })
  ipc.on('close', () => {
    if (tearingDown) return
    // Once the Rust server disappears, panes stop updating and every pending
    // request has already been rejected. Exit cleanly instead of hanging.
    cleanupTerminal()
    process.stderr.write('hux: server connection lost\n')
    process.exit(1)
  })
  ipc.on('error', () => {
    // Already surfaced by the 'close' handler; swallow so EventEmitter doesn't
    // throw. The close path is the source of truth for teardown.
  })
  ipc.on('bye', (ev: unknown) => {
    const { reason } = ev as { reason: string }
    if (reason === 'kicked') {
      // Server forced a resync (e.g. we fell behind the broadcast). Easiest
      // correct recovery is to tear down and let the user restart; the tab/pane
      // layout is already persisted.
      cleanupTerminal()
      process.stderr.write('hux: server asked for resync — restarting\n')
      process.exit(2)
    }
  })
  try {
    const res = await ipc.attachSession(currentSessionName, !sessionMustExist)
    if (sessionMustBeNew && !res.created) {
      cleanupTerminal()
      process.stderr.write(
        `hux: session "${currentSessionName}" already exists — use \`hux attach -t ${currentSessionName}\`\n`,
      )
      process.exit(1)
    }
    state = { ...state, sessionName: currentSessionName }
  } catch (err) {
    cleanupTerminal()
    process.stderr.write(`hux: attach session: ${(err as Error).message}\n`)
    process.exit(1)
  }
  ipc.beginAttach()
  try {
    await loadAndReconcile()
  } finally {
    ipc.endAttach()
  }
  await startInteractive()
}

async function loadAndReconcile(): Promise<void> {
  const { version, blob } = await ipc.getState(currentSessionName)
  stateVersion = version
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as AppState
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        state = {
          ...parsed,
          mode: 'normal',
          status: '',
          drag: { kind: 'none' },
          renaming: undefined,
          reservedPanes: Array.isArray(parsed.reservedPanes)
            ? parsed.reservedPanes
            : [],
          closedPanes: Array.isArray(parsed.closedPanes) ? parsed.closedPanes : [],
          contextMenu: undefined,
          hoverPeek: undefined,
          expose: false,
          sessionName: currentSessionName,
          sessionRenaming: undefined,
          sessionPicker: undefined,
        }
      }
    } catch {}
  }

  const list = await ipc.listPanes()
  const currentSessionPanes = list.panes.filter(p => p.session === currentSessionName)
  const aliveServer = new Map(currentSessionPanes.map(p => [p.id, p]))
  const stateIds = new Set<string>()
  for (const tab of state.tabs) {
    for (const id of collectPaneIds(tab.root)) stateIds.add(id)
  }
  for (const id of stateIds) {
    const sp = aliveServer.get(id)
    if (!sp || !sp.alive) state = closePane(state, id)
  }
  const reserved = new Set(state.reservedPanes)
  for (const [id] of aliveServer) {
    if (stateIds.has(id) || reserved.has(id)) continue
    await ipc.closePane(id).catch(() => {})
  }
  state = pruneReservedPanes(state, id => {
    const sp = aliveServer.get(id)
    return !!sp && sp.alive
  })
  if (state.tabs.length === 0) {
    state = createInitialState()
  }
  await initialSyncSessions()
  schedulePersist()
}

async function initialSyncSessions(): Promise<void> {
  const activeIds = new Set<string>()
  for (const tab of state.tabs) {
    for (const id of collectPaneIds(tab.root)) activeIds.add(id)
  }
  const list = await ipc.listPanes()
  const alive = new Set(
    list.panes
      .filter(p => p.session === currentSessionName && p.alive)
      .map(p => p.id),
  )
  for (const id of activeIds) {
    if (sessions.has(id)) continue
    if (alive.has(id)) {
      try {
        const grid = await ipc.getGrid(id)
        sessions.set(id, createSession(id, {
          rows: grid.rows,
          cols: grid.cols,
          cells: grid.cells,
          cursor_x: grid.cursor_x,
          cursor_y: grid.cursor_y,
          alternate_screen: grid.alternate_screen,
          mouse_protocol: grid.mouse_protocol,
        }))
      } catch {
        sessions.set(id, createSession(id))
      }
    } else {
      sessions.set(id, createSession(id))
    }
  }
}

async function attachSessionInPlace(name: string): Promise<void> {
  if (name === currentSessionName) return
  for (const session of sessions.values()) session.detach()
  sessions.clear()
  const res = await ipc.attachSession(name, false)
  currentSessionName = res.name
  ipc.beginAttach()
  try {
    const { version, blob } = await ipc.getState(currentSessionName)
    stateVersion = version
    if (blob) {
      try {
        const parsed = JSON.parse(blob) as AppState
        if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          state = {
            ...parsed,
            mode: 'normal',
            status: `attached ${currentSessionName}`,
            drag: { kind: 'none' },
            renaming: undefined,
            reservedPanes: Array.isArray(parsed.reservedPanes) ? parsed.reservedPanes : [],
            closedPanes: Array.isArray(parsed.closedPanes) ? parsed.closedPanes : [],
            contextMenu: undefined,
            hoverPeek: undefined,
            expose: false,
            sessionName: currentSessionName,
            sessionRenaming: undefined,
            sessionPicker: undefined,
          }
        } else {
          state = { ...createInitialState(), sessionName: currentSessionName }
        }
      } catch {
        state = { ...createInitialState(), sessionName: currentSessionName }
      }
    } else {
      state = { ...createInitialState(), sessionName: currentSessionName }
    }

    const list = await ipc.listPanes()
    const alive = new Map(
      list.panes
        .filter(p => p.session === currentSessionName && p.alive)
        .map(p => [p.id, p]),
    )
    const stateIds = new Set<string>()
    for (const tab of state.tabs) {
      for (const id of collectPaneIds(tab.root)) stateIds.add(id)
    }
    for (const id of stateIds) {
      if (!alive.has(id)) state = closePane(state, id)
    }
    state = pruneReservedPanes(state, id => alive.has(id))
    if (state.tabs.length === 0) state = createInitialState()

    const finalIds = new Set<string>()
    for (const tab of state.tabs) {
      for (const id of collectPaneIds(tab.root)) finalIds.add(id)
    }
    for (const id of finalIds) {
      if (alive.has(id)) {
        try {
          const grid = await ipc.getGrid(id)
          sessions.set(id, createSession(id, {
            rows: grid.rows,
            cols: grid.cols,
            cells: grid.cells,
            cursor_x: grid.cursor_x,
            cursor_y: grid.cursor_y,
            alternate_screen: grid.alternate_screen,
            mouse_protocol: grid.mouse_protocol,
          }))
        } catch {
          sessions.set(id, createSession(id))
        }
      } else {
        sessions.set(id, createSession(id))
      }
    }
  } finally {
    ipc.endAttach()
  }
  scheduleRender()
  schedulePersist()
}

function schedulePersist(): void {
  if (persistScheduled) return
  persistScheduled = true
  setTimeout(() => {
    persistScheduled = false
    persistState()
  }, 100)
}

async function persistState(): Promise<void> {
  const { history, ...persistable } = state
  void history
  const blob = JSON.stringify(persistable)
  try {
    const res = await ipc.setState(stateVersion, blob, currentSessionName)
    stateVersion = res.version
  } catch {
    try {
      const cur = await ipc.getState(currentSessionName)
      stateVersion = cur.version
      const res = await ipc.setState(stateVersion, blob, currentSessionName)
      stateVersion = res.version
    } catch {
      // give up this round
    }
  }
}

async function startInteractive(): Promise<void> {
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')

  await probeTerminalCaps()

  process.stdin.on('data', handleInput)
  process.stdin.resume()

  process.stdout.write(
    `${ENTER_ALT_SCREEN}${HIDE_CURSOR}${enableMouse()}${CLEAR_SCREEN}`,
  )

  if (kittyPeekSupported) {
    debugLogLine('sending CSI 16 t and CSI 14 t')
    process.stdout.write('\x1b[16t\x1b[14t')
  }

  syncSessions()
  render()
  process.stdout.on('resize', () => scheduleRender())
  process.on('SIGINT', () => detach())
  // SIGTERM / SIGHUP: without a handler, Node exits immediately and skips the
  // normal `process.on('exit')` path, leaving the terminal in alt-screen + raw
  // mode. Route both through detach() so state is persisted and the terminal
  // is restored.
  process.on('SIGTERM', () => detach())
  process.on('SIGHUP', () => detach())
  process.on('exit', cleanupTerminal)

  startDragDaemonConnect()
}

function interactiveShellArgs(shell: string): string[] {
  const name = shell.split('/').pop() ?? ''
  if (name === 'bash' || name === 'zsh') {
    return ['-il']
  }
  if (name === 'fish') {
    return ['-il']
  }
  return []
}

function scheduleRender(): void {
  if (renderScheduled) return
  renderScheduled = true
  setImmediate(() => {
    renderScheduled = false
    render()
  })
}

function syncSessions(): void {
  const activeIds = new Set<string>()
  for (const tab of state.tabs) {
    for (const id of collectPaneIds(tab.root)) {
      activeIds.add(id)
    }
  }

  for (const [id, session] of sessions) {
    if (!activeIds.has(id)) {
      session.dispose()
      sessions.delete(id)
    }
  }

  for (const id of activeIds) {
    if (!sessions.has(id)) {
      sessions.set(id, createSession(id))
    }
  }
}

function createSession(
  paneId: string,
  seedGrid?: {
    rows: number
    cols: number
    cells: import('./ipc.js').Cell[][]
    cursor_x: number
    cursor_y: number
    alternate_screen?: boolean
    mouse_protocol?: boolean
  },
): TerminalSession {
  const columns = process.stdout.columns || 120
  const rows = process.stdout.rows || 32
  const initialCols = Math.max(20, Math.floor(columns / 2) - 4)
  const initialRows = Math.max(5, rows - 8)

  return new TerminalSession({
    id: paneId,
    client: ipc,
    shell: shellPath,
    shellArgs,
    cwd: initialCwd,
    cols: initialCols,
    rows: initialRows,
    session: currentSessionName,
    seedGrid,
    callbacks: {
      onTitle: title => {
        if (!title) return
        state = setPaneTitle(state, paneId, title)
        scheduleRender()
      },
      onUpdate: () => {
        const tab = activeTab(state)
        const isCurrentlyFocused =
          tab.id === state.activeTabId && tab.focusedPaneId === paneId
        if (!isCurrentlyFocused) {
          activityPanes.add(paneId)
        }
        scheduleRender()
      },
      onExit: () => onShellExit(paneId),
    },
  })
}

function onShellExit(paneId: string): void {
  const session = sessions.get(paneId)
  if (session) {
    session.dispose()
    sessions.delete(paneId)
  }
  if (totalPaneCount() <= 1) {
    shutdown()
    return
  }
  state = closePane(state, paneId)
  scheduleRender()
}

function paintForPane(paneId: string): PaintFn | null {
  const session = sessions.get(paneId)
  if (!session) return null
  const tab = activeTab(state)
  const isFocusedPane =
    tab.id === state.activeTabId && tab.focusedPaneId === paneId
  const scrollState = getScrollState()
  const scroll = scrollState && scrollState.paneId === paneId ? scrollState : null
  const sel = selectionOverlayFor(paneId)
  const highlight = searchHighlightFor(paneId)

  return (painter, rect) => {
    session.resize(rect.width, rect.height)
    if (scroll || sel || highlight) {
      const grid = scroll ? scroll.grid : session.cells
      paintCells(painter, rect, grid, sel, highlight)
      return
    }
    if (isFocusedPane) {
      session.paintInto(painter, rect)
    } else {
      session.paintWithCursorMarker(painter, rect)
    }
  }
}

function paneContentRect(paneId: string): HitRegion | null {
  return hitRegions.find(r => r.id === `pane:${paneId}`) ?? null
}

function paneLocalCoords(
  paneId: string,
  eventX: number,
  eventY: number,
  clamp = false,
): { x: number; y: number } | null {
  const rect = paneContentRect(paneId)
  if (!rect) return null
  const localX = eventX - rect.x
  const localY = eventY - rect.y - 1
  if (!clamp) {
    if (
      localX < 0 || localX >= rect.width ||
      localY < 0 || localY >= rect.height - 1
    ) {
      return null
    }
    return { x: localX, y: localY }
  }
  const session = sessions.get(paneId)
  const scroll = getScrollState()
  const cols = scroll?.paneId === paneId ? scroll.cols : session?.dimensions.cols ?? rect.width
  const rows = scroll?.paneId === paneId ? scroll.rows : session?.dimensions.rows ?? rect.height - 1
  const cx = Math.max(0, Math.min(cols - 1, localX))
  const cy = Math.max(0, Math.min(rows - 1, localY))
  return { x: cx, y: cy }
}

function forwardWheelToPane(
  session: TerminalSession,
  paneId: string,
  event: { direction: 'up' | 'down'; x: number; y: number },
): void {
  if (session.usesMouseProtocol) {
    const local = paneLocalCoords(paneId, event.x, event.y, true)
    if (!local) return
    const code = event.direction === 'up' ? 64 : 65
    const seq = `\x1b[<${code};${local.x + 1};${local.y + 1}M`
    session.write(seq)
    return
  }
  const key = event.direction === 'up' ? '\x1b[A' : '\x1b[B'
  session.write(key.repeat(WHEEL_LINES))
}

function forwardMouseToPane(
  session: TerminalSession,
  paneId: string,
  kind: 'press' | 'drag' | 'release',
  x: number,
  y: number,
  shift: boolean,
): boolean {
  const local = paneLocalCoords(paneId, x, y, true)
  if (!local) return false
  const motion = kind === 'drag' ? 32 : 0
  const shiftBit = shift ? 4 : 0
  const code = motion | shiftBit
  const suffix = kind === 'release' ? 'm' : 'M'
  const seq = `\x1b[<${code};${local.x + 1};${local.y + 1}${suffix}`
  session.write(seq)
  return true
}

async function handleInput(input: string): Promise<void> {
  debugLogInput(input)
  const prevState = state
  historyLocked = false
  let remaining = pendingInput + input
  pendingInput = ''
  remaining = consumeTerminalSizeResponses(remaining)
  let forwardBuf = ''
  let changed = false

  const flushForward = () => {
    if (forwardBuf.length === 0) return
    if (getScrollState()) {
      setScrollState(null)
      changed = true
    }
    const tab = activeTab(state)
    if (tab.synchronize) {
      for (const id of collectPaneIds(tab.root)) {
        const session = sessions.get(id)
        if (session) session.write(forwardBuf)
      }
    } else {
      const pane = focusedPane()
      const session = pane ? sessions.get(pane.id) : undefined
      if (session) {
        session.write(forwardBuf)
      }
    }
    forwardBuf = ''
  }

  while (remaining.length > 0) {
    const mouse = consumeMouseSequence(remaining)
    if (mouse) {
      flushForward()
      remaining = remaining.slice(mouse.raw.length)
      if (mouse.kind === 'hover') {
        updatePointerShape(mouse.x, mouse.y)
        handleHover(mouse.x, mouse.y)
        continue
      }
      if (mouse.kind !== 'ignore') {
        handleMouse(mouse)
        updatePointerShape(mouse.x, mouse.y)
        changed = true
      }
      continue
    }

    if (state.sessionPicker) {
      flushForward()
      const consumed = await consumePickerKey(remaining)
      if (consumed > 0) {
        remaining = remaining.slice(consumed)
        changed = true
        continue
      }
    }

    if (state.sessionRenaming) {
      flushForward()
      const consumed = consumeSessionRenameKey(remaining)
      remaining = remaining.slice(consumed)
      changed = true
      continue
    }

    if (state.renaming) {
      flushForward()
      const consumed = consumeRenameKey(remaining)
      remaining = remaining.slice(consumed)
      changed = true
      continue
    }

    if (isSearching()) {
      flushForward()
      const consumed = consumeSearchKey(remaining)
      if (consumed > 0) {
        remaining = remaining.slice(consumed)
        changed = true
        continue
      }
    }

    if (state.contextMenu || state.expose) {
      flushForward()
      const consumed = consumeModalKey(remaining)
      remaining = remaining.slice(consumed)
      changed = true
      continue
    }

    if (remaining.startsWith('\x02')) {
      flushForward()
      remaining = remaining.slice(1)
      state = setMode(state, 'prefix')
      state = setStatus(state, 'prefix — press a command key')
      changed = true
      continue
    }

    if (state.mode === 'prefix') {
      flushForward()
      const consumed = consumePrefixKey(remaining)
      remaining = remaining.slice(consumed.raw.length)
      handlePrefixKey(consumed.raw)
      changed = true
      continue
    }

    const alwaysScroll = consumeAlwaysScrollKey(remaining)
    if (alwaysScroll > 0) {
      flushForward()
      remaining = remaining.slice(alwaysScroll)
      changed = true
      continue
    }

    if (getScrollState()) {
      const scrolled = consumeScrollKey(remaining)
      if (scrolled > 0) {
        remaining = remaining.slice(scrolled)
        changed = true
        continue
      }
    }

    if (state.drag.kind !== 'none' && remaining.startsWith('\x1b')) {
      // Don't misread a partial SGR mouse report as a bare ESC key press —
      // reads can split mid-sequence, which otherwise cancels the drag
      // spuriously and races the daemon's drop, voiding the Ghostty handoff.
      if (remaining.startsWith('\x1b[<') || remaining.startsWith('\x1b[M')) {
        pendingInput = remaining
        remaining = ''
        continue
      }
      const esc = consumePrefixKey(remaining)
      if (esc.raw === '\x1b') {
        remaining = remaining.slice(1)
        state = cancelDrag(state)
        notifyDragCancelled()
        state = setStatus(state, 'drag cancelled')
        changed = true
        continue
      }
    }

    const next = findNextBoundary(remaining)
    if (next === 0) {
      forwardBuf += remaining[0]
      remaining = remaining.slice(1)
    } else {
      forwardBuf += remaining.slice(0, next)
      remaining = remaining.slice(next)
    }
  }

  flushForward()

  if (changed) {
    if (!historyLocked) state = recordHistory(prevState, state)
    render()
    schedulePersist()
  }
}

function findNextBoundary(input: string): number {
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    if (ch === 0x02) return i
    if (ch === 0x1b && input[i + 1] === '[' && input[i + 2] === '<') {
      return i
    }
  }
  return input.length
}

function consumePrefixKey(input: string): { raw: string } {
  const escSeq = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z]|[a-zA-Z0-9])/.exec(input)
  if (escSeq) return { raw: escSeq[0]! }
  return { raw: Array.from(input)[0] ?? '' }
}

function consumeAlwaysScrollKey(input: string): number {
  const match = /^\x1b\[(?:5;2~|6;2~|1;2H|1;2F|1;2A|1;2B)/.exec(input)
  if (!match) return 0
  const seq = match[0]
  if (seq === '\x1b[5;2~') scrollFocusedPaneBy(scrollPageSize())
  else if (seq === '\x1b[6;2~') scrollFocusedPaneBy(-scrollPageSize())
  else if (seq === '\x1b[1;2H') scrollFocusedPaneBy(10000)
  else if (seq === '\x1b[1;2F') scrollFocusedPaneBy(-10000)
  else if (seq === '\x1b[1;2A') scrollFocusedPaneBy(1)
  else if (seq === '\x1b[1;2B') scrollFocusedPaneBy(-1)
  else return 0
  return seq.length
}

function consumeScrollKey(input: string): number {
  const match = /^\x1b(?:\[(?:5~|6~|1~|4~|H|F|A|B)|O[HFAB])/.exec(input)
  if (!match) return 0
  const seq = match[0]
  if (seq === '\x1b[5~') scrollFocusedPaneBy(scrollPageSize())
  else if (seq === '\x1b[6~') scrollFocusedPaneBy(-scrollPageSize())
  else if (seq === '\x1b[H' || seq === '\x1bOH' || seq === '\x1b[1~') scrollFocusedPaneBy(10000)
  else if (seq === '\x1b[F' || seq === '\x1bOF' || seq === '\x1b[4~') scrollFocusedPaneBy(-10000)
  else if (seq === '\x1b[A' || seq === '\x1bOA') scrollFocusedPaneBy(1)
  else if (seq === '\x1b[B' || seq === '\x1bOB') scrollFocusedPaneBy(-1)
  else return 0
  return seq.length
}

function consumeModalKey(input: string): number {
  if (input.length === 0) return 0
  const first = input[0]!
  if (first === '\x1b') {
    const esc = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
    if (!esc) {
      if (state.contextMenu) state = closeContextMenu(state)
      else if (state.expose) state = exitExpose(state)
      return 1
    }
    const seq = esc[0]
    if (state.contextMenu) {
      const items = contextMenuItemsFor(state, state.contextMenu)
      if (items.length > 0) {
        if (seq === '\x1b[A' || seq === '\x1bOA') {
          const cur = state.contextMenu.cursor
          state = moveContextMenuCursor(state, (cur - 1 + items.length) % items.length)
          return seq.length
        }
        if (seq === '\x1b[B' || seq === '\x1bOB') {
          const cur = state.contextMenu.cursor
          state = moveContextMenuCursor(state, (cur + 1) % items.length)
          return seq.length
        }
      }
    }
    return seq.length
  }
  if (first === '\r' || first === '\n') {
    if (state.contextMenu) {
      const items = contextMenuItemsFor(state, state.contextMenu)
      const item = items[state.contextMenu.cursor]
      const target = state.contextMenu.target
      state = closeContextMenu(state)
      if (item) dispatchContextAction(target, item.action)
    } else if (state.expose) {
      state = exitExpose(state)
    }
    return 1
  }
  if (first === '=' && state.expose) {
    state = exitExpose(state)
    return 1
  }
  return 1
}

function consumeSessionRenameKey(input: string): number {
  if (input.length === 0) return 0
  const first = input[0]!

  if (first === '\r' || first === '\n') {
    void commitSessionRename()
    return 1
  }
  if (first === '\x7f' || first === '\x08') {
    backspaceSessionRename()
    return 1
  }
  if (first === '\x15') {
    clearSessionRename()
    return 1
  }
  if (first === '\x03') {
    cancelSessionRename()
    return 1
  }
  if (first === '\x1b') {
    const esc = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
    if (esc) return esc[0].length
    cancelSessionRename()
    return 1
  }

  const code = first.charCodeAt(0)
  if (code < 0x20) return 1

  const char = Array.from(input)[0]!
  appendSessionRename(char)
  return char.length
}

function consumeRenameKey(input: string): number {
  if (input.length === 0) return 0
  const first = input[0]!

  if (first === '\r' || first === '\n') {
    state = commitTabRename(state)
    return 1
  }
  if (first === '\x7f' || first === '\x08') {
    state = backspaceTabRename(state)
    return 1
  }
  if (first === '\x15') {
    state = clearTabRenameBuffer(state)
    return 1
  }
  if (first === '\x03') {
    state = cancelTabRename(state)
    return 1
  }
  if (first === '\x1b') {
    const esc = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
    if (esc) {
      return esc[0].length
    }
    state = cancelTabRename(state)
    return 1
  }

  const code = first.charCodeAt(0)
  if (code < 0x20) {
    return 1
  }

  const char = Array.from(input)[0]!
  state = appendTabRename(state, char)
  return char.length
}

function handleMouse(event: MouseEvent): void {
  if (event.kind === 'wheel') {
    if (state.expose || state.contextMenu) return
    const region = findRegion(event.x, event.y)
    if (!region) return
    let paneId: string | null = null
    if (region.id.startsWith('pane:')) {
      paneId = region.id.slice('pane:'.length)
    } else if (region.id.startsWith('pane-header:')) {
      paneId = region.id.slice('pane-header:'.length)
    }
    if (!paneId) return
    state = focusPane(state, paneId)
    const session = sessions.get(paneId)
    if (session && !event.shift && (session.usesAltScreen || session.usesMouseProtocol)) {
      forwardWheelToPane(session, paneId, event)
      return
    }
    const delta = event.direction === 'up' ? WHEEL_LINES : -WHEEL_LINES
    const scroll = getScrollState()
    if (scroll && scroll.paneId !== paneId) setScrollState(null)
    void scrollPane(paneId, delta)
    return
  }

  if (mouseForwardPane && (event.kind === 'drag' || event.kind === 'release')) {
    const session = sessions.get(mouseForwardPane)
    if (session) {
      forwardMouseToPane(session, mouseForwardPane, event.kind, event.x, event.y, event.shift)
    }
    if (event.kind === 'release') mouseForwardPane = null
    return
  }

  if (event.kind === 'rpress') {
    const region = findRegion(event.x, event.y)
    clearHoverPeek()
    if (state.expose) {
      state = exitExpose(state)
    }
    state = closeContextMenu(state)
    if (!region) return
    if (region.id.startsWith('pane:') || region.id.startsWith('pane-header:')) {
      const paneId = region.id.startsWith('pane:')
        ? region.id.slice('pane:'.length)
        : region.id.slice('pane-header:'.length)
      state = focusPane(state, paneId)
      state = openContextMenu(state, { kind: 'pane', paneId }, event.x, event.y)
      return
    }
    if (region.id.startsWith('tab:')) {
      const tabId = region.id.slice('tab:'.length)
      state = openContextMenu(state, { kind: 'tab', tabId }, event.x, event.y)
      return
    }
    return
  }

  if (event.kind === 'press' && state.contextMenu) {
    const region = findRegion(event.x, event.y)
    if (region && region.id.startsWith('ctx-item:')) {
      const action = region.id.slice('ctx-item:'.length)
      const target = state.contextMenu.target
      state = closeContextMenu(state)
      dispatchContextAction(target, action)
      return
    }
    state = closeContextMenu(state)
    return
  }

  if (event.kind === 'press' && state.expose) {
    const region = findRegion(event.x, event.y)
    if (region?.id.startsWith('expose:')) {
      const paneId = region.id.slice('expose:'.length)
      state = focusPane(state, paneId)
      state = exitExpose(state)
      return
    }
    state = exitExpose(state)
    return
  }

  if (event.kind === 'drag' && hasActiveSelection()) {
    updateSelectionCursor(event.x, event.y)
    return
  }

  if (event.kind === 'release' && hasActiveSelection()) {
    releaseSelection()
    return
  }

  if (event.kind === 'press') {
    const region = findRegion(event.x, event.y)
    if (state.renaming) {
      const onEditingTab = region?.id === `tab:${state.renaming.tabId}`
      if (onEditingTab) return
      state = commitTabRename(state)
    }
    clearHoverPeek()
    clearSelection()
    mouseForwardPane = null
    if (!region) return
    if (region.id.startsWith('split-handle:')) {
      const splitId = region.id.slice('split-handle:'.length)
      const container = hitRegions.find(r => r.id === `split:${splitId}`)
      if (!container) return
      state = startResizeDrag(
        state,
        splitId,
        {
          x: container.x,
          y: container.y,
          width: container.width,
          height: container.height,
        },
        event.x,
        event.y,
      )
      return
    }
    if (region.id.startsWith('pane-header:')) {
      const paneId = region.id.slice('pane-header:'.length)
      state = focusPane(state, paneId)
      state = startPaneDrag(state, paneId, event.x, event.y, currentTabLayout())
      notifyPaneDragStart(paneId)
      return
    }
    if (region.id.startsWith('tab:')) {
      const tabId = region.id.slice('tab:'.length)
      state = startTabDrag(state, tabId, event.x, event.y, currentTabLayout())
      notifyTabDragStart(tabId)
      return
    }
    if (region.id === 'tab-new') {
      state = newTab(state)
      syncSessions()
      return
    }
    if (region.id.startsWith('pane:')) {
      const paneId = region.id.slice('pane:'.length)
      state = focusPane(state, paneId)
      const session = sessions.get(paneId)
      if (session?.usesMouseProtocol && !event.shift) {
        if (forwardMouseToPane(session, paneId, 'press', event.x, event.y, event.shift)) {
          mouseForwardPane = paneId
        }
        return
      }
      const local = paneLocalCoords(paneId, event.x, event.y)
      if (local) startSelection(paneId, local)
      return
    }
    return
  }

  if (event.kind === 'drag') {
    state = updateDrag(state, event.x, event.y)
    return
  }

  if (event.kind === 'release') {
    const region = findRegion(event.x, event.y)

    if (
      region?.id.startsWith('tab:') &&
      state.drag.kind === 'tab' &&
      !state.drag.moved
    ) {
      const tabId = region.id.slice('tab:'.length)
      if (state.drag.tabId === tabId) {
        const now = Date.now()
        if (
          lastTabClick &&
          lastTabClick.tabId === tabId &&
          now - lastTabClick.at <= DOUBLE_CLICK_MS
        ) {
          state = cancelDrag(state)
          state = startTabRename(state, tabId)
          lastTabClick = null
          return
        }
        lastTabClick = { tabId, at: now }
      }
    }

    const wasPaneOrTabDrag =
      state.drag.kind === 'pane' || state.drag.kind === 'tab'
    const target = toDropTarget(region, event.x, event.y)
    const before = state
    state = endDrag(state, target)
    if (wasPaneOrTabDrag) notifyDragCancelled()
    if (state !== before) {
      syncSessions()
    }
    return
  }
}

function toDropTarget(
  region: HitRegion | undefined,
  cursorX: number,
  cursorY: number,
): DropTarget {
  if (!region) return { kind: 'none' }
  if (region.id.startsWith('pane:') || region.id.startsWith('pane-header:')) {
    const paneId = region.id.startsWith('pane:')
      ? region.id.slice('pane:'.length)
      : region.id.slice('pane-header:'.length)
    const paneRegion =
      hitRegions.find(r => r.id === `pane:${paneId}`) ?? region
    const direction = computeSplitDirection(paneRegion, cursorX, cursorY)
    return { kind: 'pane', paneId, direction }
  }
  if (
    (state.drag.kind === 'tab' || state.drag.kind === 'pane') &&
    (region.id.startsWith('tab:') || region.id === 'tabbar' || region.id === 'tab-new')
  ) {
    if (state.drag.kind === 'pane' && region.id.startsWith('tab:')) {
      const tabId = region.id.slice('tab:'.length)
      if (state.drag.fromTabId !== tabId) {
        return { kind: 'tab', tabId, insertIndex: 0 }
      }
    }
    const insertIndex = computeTabInsertIndexFromLayout(cursorX, state.drag.tabLayout)
    return { kind: 'tabbar', insertIndex }
  }
  if (region.id.startsWith('tab:')) {
    const tabId = region.id.slice('tab:'.length)
    const tabIndex = state.tabs.findIndex(t => t.id === tabId)
    const midX = region.x + region.width / 2
    const base = tabIndex < 0 ? state.tabs.length : tabIndex
    const insertIndex = cursorX < midX ? base : base + 1
    return { kind: 'tab', tabId, insertIndex }
  }
  if (region.id === 'tab-new') {
    return { kind: 'tabbar', insertIndex: state.tabs.length }
  }
  if (region.id === 'tabbar') {
    return { kind: 'tabbar', insertIndex: computeTabInsertIndex(cursorX) }
  }
  return { kind: 'none' }
}

function computeTabInsertIndexFromLayout(
  cursorX: number,
  layout: ReadonlyArray<{ id: string; x: number; width: number }>,
): number {
  for (let i = 0; i < layout.length; i++) {
    const t = layout[i]!
    if (cursorX < t.x + t.width / 2) return i
  }
  return layout.length
}

function currentTabLayout(): Array<{ id: string; x: number; width: number }> {
  return state.tabs
    .map(t => {
      const r = hitRegions.find(h => h.id === `tab:${t.id}`)
      return r ? { id: t.id, x: r.x, width: r.width } : null
    })
    .filter((v): v is { id: string; x: number; width: number } => v !== null)
}

function computeSplitDirection(
  paneRect: { x: number; y: number; width: number; height: number },
  cursorX: number,
  cursorY: number,
): SplitDirection {
  const centerX = paneRect.x + paneRect.width / 2
  const centerY = paneRect.y + paneRect.height / 2
  const halfW = Math.max(1, paneRect.width / 2)
  const halfH = Math.max(1, paneRect.height / 2)
  const normX = (cursorX - centerX) / halfW
  const normY = (cursorY - centerY) / halfH
  if (Math.abs(normX) >= Math.abs(normY)) {
    return normX >= 0 ? 'right' : 'left'
  }
  return normY >= 0 ? 'bottom' : 'top'
}

function computeSplitGhostRect(
  paneRect: { x: number; y: number; width: number; height: number },
  direction: SplitDirection,
): { x: number; y: number; width: number; height: number } {
  const halfW = Math.max(1, Math.floor(paneRect.width / 2))
  const halfH = Math.max(1, Math.floor(paneRect.height / 2))
  switch (direction) {
    case 'left':
      return { x: paneRect.x, y: paneRect.y, width: halfW, height: paneRect.height }
    case 'right':
      return {
        x: paneRect.x + paneRect.width - halfW,
        y: paneRect.y,
        width: halfW,
        height: paneRect.height,
      }
    case 'top':
      return { x: paneRect.x, y: paneRect.y, width: paneRect.width, height: halfH }
    case 'bottom':
      return {
        x: paneRect.x,
        y: paneRect.y + paneRect.height - halfH,
        width: paneRect.width,
        height: halfH,
      }
  }
}

function computeTabInsertIndex(cursorX: number): number {
  for (let i = 0; i < state.tabs.length; i++) {
    const tab = state.tabs[i]!
    const region = hitRegions.find(r => r.id === `tab:${tab.id}`)
    if (!region) continue
    const midX = region.x + region.width / 2
    if (cursorX < midX) return i
  }
  return state.tabs.length
}

function computeDropPreview(): DropPreview | null {
  if (state.drag.kind === 'none' || !state.drag.moved) return null
  if (state.drag.kind === 'resize') return null

  const region = findRegion(state.drag.x, state.drag.y)
  const target = toDropTarget(region, state.drag.x, state.drag.y)

  if (target.kind === 'none') return null

  if (target.kind === 'pane') {
    if (state.drag.kind === 'pane' && state.drag.paneId === target.paneId) {
      return null
    }
    const paneRegion = hitRegions.find(r => r.id === `pane:${target.paneId}`)
    if (!paneRegion) return null
    const ghostRect = computeSplitGhostRect(paneRegion, target.direction)
    const sourceTitle =
      state.drag.kind === 'pane' ? state.drag.paneTitle : state.drag.tabTitle
    const sourceAccent =
      state.drag.kind === 'pane' ? state.drag.paneAccent : 117
    return {
      splitPreview: {
        paneId: target.paneId,
        direction: target.direction,
        ghostRect,
        sourceTitle,
        sourceAccent,
      },
    }
  }

  if (target.kind === 'tab') {
    if (state.drag.kind === 'pane') {
      if (state.drag.fromTabId === target.tabId) return null
      return { highlightTabId: target.tabId }
    }
    return tabReorderPreview(target.insertIndex)
  }

  if (target.kind === 'tabbar') {
    if (state.drag.kind === 'pane') {
      const info = findPaneInTabs(state, state.drag.paneId)
      if (info && info.tab.root.kind === 'leaf' && state.tabs.length === 1) {
        return {
          actionLabel: '✗ cannot promote — this is the last remaining pane',
        }
      }
      return tabPromotePreview(target.insertIndex)
    }
    return tabReorderPreview(target.insertIndex)
  }

  return null
}

function tabReorderPreview(insertIndex: number): DropPreview | null {
  const drag = state.drag
  if (drag.kind !== 'tab') return null
  const fromIndex = state.tabs.findIndex(t => t.id === drag.tabId)
  if (fromIndex < 0) return null
  const toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex
  if (toIndex === fromIndex) return null
  const clamped = Math.max(0, Math.min(state.tabs.length - 1, toIndex))
  return { tabReorder: { tabId: drag.tabId, toIndex: clamped } }
}

function tabPromotePreview(insertIndex: number): DropPreview | null {
  const drag = state.drag
  if (drag.kind !== 'pane') return null
  return {
    tabPromote: {
      insertIndex: Math.max(0, Math.min(state.tabs.length, insertIndex)),
      title: drag.paneTitle,
      accent: drag.paneAccent,
    },
  }
}

function handleHover(x: number, y: number): void {
  const region = findRegion(x, y)

  if (state.contextMenu && region?.id.startsWith('ctx-item:')) {
    const action = region.id.slice('ctx-item:'.length)
    const items = contextMenuItemsFor(state, state.contextMenu)
    const idx = items.findIndex(it => it.action === action)
    if (idx >= 0 && idx !== state.contextMenu.cursor) {
      state = moveContextMenuCursor(state, idx)
      scheduleRender()
    }
  }

  if (state.expose || state.drag.kind !== 'none') {
    clearHoverPeek()
    return
  }
  if (region?.id.startsWith('tab:')) {
    const tabId = region.id.slice('tab:'.length)
    if (tabId === state.activeTabId) {
      clearHoverPeek()
      return
    }
    scheduleHoverPeek(tabId)
    return
  }
  clearHoverPeek()
}

function dispatchContextAction(
  target: ContextMenuState['target'],
  action: string,
): void {
  if (target.kind === 'pane') {
    const paneId = target.paneId
    const info = findPaneInTabs(state, paneId)
    if (!info) return
    state = focusPane(state, paneId)
    switch (action) {
      case 'split-right':
        state = splitActivePane(state, 'row')
        syncSessions()
        break
      case 'split-down':
        state = splitActivePane(state, 'column')
        syncSessions()
        break
      case 'zoom':
        state = toggleZoom(state)
        break
      case 'eject':
        ejectFocusedPane()
        break
      case 'close':
        closeFocusedPaneAndCleanup()
        break
    }
    return
  }

  const tabId = target.tabId
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) return
  switch (action) {
    case 'new':
      state = newTab(state)
      syncSessions()
      return
    case 'rename':
      state = startTabRename(state, tabId)
      return
    case 'sync':
      state = focusTab(state, tabId)
      state = toggleSynchronize(state)
      return
    case 'eject': {
      state = focusTab(state, tabId)
      ejectFocusedTab()
      return
    }
    case 'close': {
      state = focusTab(state, tabId)
      for (const id of collectPaneIds(tab.root)) {
        state = closePane(state, id)
      }
      syncSessions()
      return
    }
  }
}

function findRegion(x: number, y: number): HitRegion | undefined {
  for (let i = hitRegions.length - 1; i >= 0; i--) {
    const region = hitRegions[i]!
    if (
      x >= region.x &&
      y >= region.y &&
      x < region.x + region.width &&
      y < region.y + region.height
    ) {
      return region
    }
  }
  return undefined
}

function focusedPane(): Pane | null {
  const tab = activeTab(state)
  const found = findPaneInTabs(state, tab.focusedPaneId)
  return found?.pane ?? null
}

function totalPaneCount(): number {
  return state.tabs.reduce((acc, t) => acc + collectPaneIds(t.root).length, 0)
}

function handlePrefixKey(raw: string): void {
  state = setMode(state, 'normal')

  if (raw === '\x1b[A' || raw === '\x1bOA' || raw === '\x1b[D' || raw === '\x1bOD') {
    state = cycleFocusedPane(state, -1)
    return
  }
  if (raw === '\x1b[B' || raw === '\x1bOB' || raw === '\x1b[C' || raw === '\x1bOC') {
    state = cycleFocusedPane(state, 1)
    return
  }
  if (raw === '\x1b[5~') {
    scrollFocusedPaneBy(scrollPageSize())
    return
  }
  if (raw === '\x1b[6~') {
    scrollFocusedPaneBy(-scrollPageSize())
    return
  }
  if (raw === '\x1b[H' || raw === '\x1bOH' || raw === '\x1b[1~') {
    scrollFocusedPaneBy(10000)
    return
  }
  if (raw === '\x1b[F' || raw === '\x1bOF' || raw === '\x1b[4~') {
    scrollFocusedPaneBy(-10000)
    return
  }
  if (raw === '\x1b') {
    state = setStatus(state, '')
    return
  }

  switch (raw) {
    case '%':
      state = splitActivePane(state, 'row')
      syncSessions()
      return
    case '"':
      state = splitActivePane(state, 'column')
      syncSessions()
      return
    case 'c':
      state = newTab(state)
      syncSessions()
      return
    case 'x':
    case 'X':
      closeFocusedPaneAndCleanup()
      return
    case 'n':
      state = focusNextTab(state, 1)
      return
    case 'p':
      state = focusNextTab(state, -1)
      return
    case 'q':
      shutdown()
      return
    case 'd':
      detach()
      return
    case 'e':
      ejectFocusedPane()
      return
    case 'E':
      ejectFocusedTab()
      return
    case 'z':
      state = toggleZoom(state)
      return
    case 'S':
      state = toggleSynchronize(state)
      return
    case '/':
      void enterSearch()
      return
    case 'T':
      reopenLastClosed()
      return
    case '=':
      state = toggleExpose(state)
      return
    case 's':
      void openSessionPicker()
      return
    case '$':
      startSessionRename()
      return
    case 'u':
      historyLocked = true
      state = undoLayout(state)
      syncSessions()
      return
    case 'U':
      historyLocked = true
      state = redoLayout(state)
      syncSessions()
      return
    case '?':
      state = setStatus(
        state,
        '% split  " split  c tab  x close  T reopen  u undo  U redo  = exposé  e eject  E eject-tab  z zoom  S sync  / search  d detach  q quit',
      )
      return
    case '\x02':
      return
    default: {
      const digit = Number.parseInt(raw, 10)
      if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
        const target = state.tabs[digit - 1]
        if (target) {
          state = focusTab(state, target.id)
        }
        return
      }
      state = setStatus(state, `unknown prefix key: ${JSON.stringify(raw)}`)
    }
  }
}

function closeFocusedPaneAndCleanup(): void {
  const pane = focusedPane()
  if (!pane) return
  if (totalPaneCount() <= 1) {
    shutdown()
    return
  }
  state = closeActivePane(state)
  syncSessions()
}

function reopenLastClosed(): void {
  const result = reopenLastClosedPane(state)
  state = result.state
  if (result.newPaneId) {
    syncSessions()
    schedulePersist()
  }
}

function ejectFocusedPane(): void {
  const pane = focusedPane()
  if (!pane) {
    state = setStatus(state, 'eject: no focused pane')
    return
  }
  if (totalPaneCount() <= 1) {
    state = setStatus(state, `eject: only one pane (${pane.id}) — split first`)
    return
  }
  const ok = ejectPaneById(pane.id)
  if (!ok) {
    state = setStatus(state, `eject: ejectPane returned no-op for ${pane.id}`)
    return
  }
  state = setStatus(
    state,
    `ejected ${pane.title} (${pane.id}) · run: hux pane-view ${pane.id}`,
  )
}

function ejectPaneById(paneId: string): boolean {
  const session = sessions.get(paneId)
  if (session) {
    session.detach()
    sessions.delete(paneId)
  }
  const before = state
  state = ejectPane(state, paneId)
  if (state === before) return false
  syncSessions()
  schedulePersist()
  return true
}

function ejectFocusedTab(): void {
  const tab = activeTab(state)
  if (!tab) {
    state = setStatus(state, 'eject tab: no active tab')
    return
  }
  const paneIds = collectPaneIds(tab.root)
  if (totalPaneCount() <= paneIds.length) {
    state = setStatus(
      state,
      `eject tab: "${tab.title}" holds the only panes — split or open a new tab first`,
    )
    return
  }
  const tabTitle = tab.title
  let ejected = 0
  for (const pid of paneIds) {
    if (ejectPaneById(pid)) ejected += 1
  }
  if (ejected === 0) {
    state = setStatus(state, `eject tab: no-op for "${tabTitle}"`)
    return
  }
  state = setStatus(
    state,
    `ejected tab "${tabTitle}" (${ejected} pane${
      ejected === 1 ? '' : 's'
    }) · run: hux pane-view <id>`,
  )
}

function sanitizeNotificationText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
}

function forwardNotification(paneId: string, body: string): void {
  const cleanedBody = sanitizeNotificationText(body)
  if (!cleanedBody) return
  const found = findPaneInTabs(state, paneId)
  const label = found ? `${found.pane.title}: ${cleanedBody}` : cleanedBody
  process.stdout.write(`\x1b]9;${sanitizeNotificationText(label)}\x07`)
}

function render(): void {
  const columns = process.stdout.columns || 120
  const rows = process.stdout.rows || 32
  const preview = computeDropPreview()
  const tab = activeTab(state)
  const focusedId = tab.focusedPaneId
  const scroll = getScrollState()
  if (scroll && scroll.paneId !== focusedId) setScrollState(null)
  pruneSelectionForPane(focusedId)
  activityPanes.delete(focusedId)
  const hoverPeekAnchor = state.hoverPeek
    ? (() => {
        const region = hitRegions.find(r => r.id === `tab:${state.hoverPeek!.tabId}`)
        return region ? { x: region.x, width: region.width } : null
      })()
    : null
  const graphicsPeek =
    !!state.hoverPeek &&
    kittyPeekSupported &&
    !state.expose &&
    state.drag.kind === 'none' &&
    !!hoverPeekAnchor
  const graphicsExpose = !!state.expose && kittyExposeSupported
  const thumbnailLookup = graphicsExpose
    ? (() => null) as typeof thumbnailForPane
    : thumbnailForPane
  const view = buildView(state, columns, rows, {
    paintForPane,
    thumbnailForPane: thumbnailLookup,
    preview,
    activityPanes,
    hoverPeekAnchor,
    graphicsPeek,
  })
  const frame = renderView(view.root, columns, rows, {
    color: useColor,
    overlays: view.overlays,
  })
  hitRegions = frame.hitRegions
  let out = beginFrame() + frame.output
  if (graphicsPeek) {
    out += renderPeekGraphics(columns, rows)
  } else if (hasActivePeekImages()) {
    out += clearPeekGraphics()
  }
  if (graphicsExpose) {
    out += renderExposeGraphics()
  } else if (hasActiveExposeImages()) {
    out += clearExposeGraphics()
  }
  out += endFrame(focusedCursorEscape())
  process.stdout.write(out)
}


function focusedCursorEscape(): string {
  if (
    state.mode === 'prefix' ||
    state.renaming ||
    state.drag.kind !== 'none' ||
    getScrollState() ||
    isSearching() ||
    state.contextMenu ||
    state.expose ||
    state.hoverPeek ||
    hasActiveSelection()
  ) {
    return HIDE_CURSOR
  }
  const tab = activeTab(state)
  if (tab.id !== state.activeTabId) return HIDE_CURSOR
  const paneId = tab.focusedPaneId
  const session = sessions.get(paneId)
  if (!session) return HIDE_CURSOR
  const paneRegion = hitRegions.find(r => r.id === `pane:${paneId}`)
  if (!paneRegion) return HIDE_CURSOR

  const contentX = paneRegion.x
  const contentY = paneRegion.y + 1
  const contentWidth = paneRegion.width
  const contentHeight = paneRegion.height - 1
  const { x: cx, y: cy } = session.cursor
  if (cx < 0 || cy < 0 || cx >= contentWidth || cy >= contentHeight) {
    return HIDE_CURSOR
  }

  const row = contentY + cy + 1
  const col = contentX + cx + 1
  return `\x1b[${row};${col}H\x1b[?25h`
}

async function teardown({ killServer }: { killServer: boolean }): Promise<void> {
  if (tearingDown) return
  tearingDown = true
  persistScheduled = false
  try {
    await persistState()
  } catch {}
  for (const session of sessions.values()) {
    if (killServer) session.dispose()
    else session.detach()
  }
  sessions.clear()
  closeDragBridge()
  if (killServer) await ipc?.killServer().catch(() => {})
  ipc?.close()
  cleanupTerminal()
  const notice = pendingUpdateNotice()
  if (notice) process.stderr.write(`${notice}\n`)
  process.exit(0)
}

function shutdown(): void {
  void teardown({ killServer: true })
}

function detach(): void {
  void teardown({ killServer: false })
}

function cleanupTerminal(): void {
  if (cleanedUp) return
  cleanedUp = true

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  const peekCleanup = hasActivePeekImages() ? clearPeekGraphics() : ''
  const exposeCleanup = hasActiveExposeImages() ? clearExposeGraphics() : ''
  process.stdout.write(
    `${peekCleanup}${exposeCleanup}${resetPointer()}${disableMouse()}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`,
  )
}
