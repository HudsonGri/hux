export type Pane = {
  id: string
  title: string
  accent: number
}

export type PaneNode =
  | { kind: 'leaf'; id: string; pane: Pane }
  | {
      kind: 'split'
      id: string
      orientation: 'row' | 'column'
      ratio: number
      children: [PaneNode, PaneNode]
    }

export type Tab = {
  id: string
  title: string
  root: PaneNode
  focusedPaneId: string
  zoomedPaneId?: string
  synchronize?: boolean
}

export type DragKind = 'none' | 'pane' | 'tab' | 'resize'

export type ResizeBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type DragState =
  | { kind: 'none' }
  | {
      kind: 'pane'
      paneId: string
      fromTabId: string
      paneTitle: string
      paneAccent: number
      startX: number
      startY: number
      x: number
      y: number
      moved: boolean
      tabLayout: ReadonlyArray<{ id: string; x: number; width: number }>
    }
  | {
      kind: 'tab'
      tabId: string
      tabTitle: string
      startX: number
      startY: number
      x: number
      y: number
      moved: boolean
      tabLayout: ReadonlyArray<{ id: string; x: number; width: number }>
    }
  | {
      kind: 'resize'
      splitId: string
      orientation: 'row' | 'column'
      bounds: ResizeBounds
      startRatio: number
      startX: number
      startY: number
      x: number
      y: number
      moved: boolean
    }

export type CommandMode = 'normal' | 'prefix'

export type RenameState = {
  tabId: string
  buffer: string
}

export type ClosedPaneEntry = {
  pane: Pane
  tabId: string
  tabTitle: string
  wasSoleInTab: boolean
  siblingPaneIds: string[]
  orientation: 'row' | 'column'
  sourceFirst: boolean
}

export type ContextMenuTarget =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; tabId: string }

export type ContextMenuState = {
  target: ContextMenuTarget
  x: number
  y: number
  cursor: number
}

export type HoverPeek = { tabId: string }

export type SessionRenameState = {
  buffer: string
}

export type LayoutSnapshot = {
  tabs: Tab[]
  activeTabId: string
  nextId: number
}

export type LayoutHistory = {
  past: LayoutSnapshot[]
  future: LayoutSnapshot[]
}

export type AppState = {
  tabs: Tab[]
  activeTabId: string
  nextId: number
  drag: DragState
  mode: CommandMode
  status: string
  renaming?: RenameState
  reservedPanes: string[]
  closedPanes: ClosedPaneEntry[]
  contextMenu?: ContextMenuState
  hoverPeek?: HoverPeek
  expose?: boolean
  sessionName?: string
  sessionRenaming?: SessionRenameState
  sessionPicker?: SessionPickerState
  history?: LayoutHistory
}

export type SessionPickerEntry = {
  name: string
  attached: number
  lastActiveMs: number
  paneCount: number
  hasState: boolean
}

export type SessionPickerState = {
  entries: SessionPickerEntry[]
  filter: string
  cursor: number
  mode: 'browse' | 'create' | 'rename' | 'confirm-kill'
  draftName: string
  lastError?: string
}

export function createInitialState(): AppState {
  const p1: Pane = { id: 'p1', title: 'shell', accent: accentFor(0) }
  const tab: Tab = {
    id: 't1',
    title: 'tab 1',
    focusedPaneId: 'p1',
    root: { kind: 'leaf', id: 'p1', pane: p1 },
  }
  return {
    tabs: [tab],
    activeTabId: tab.id,
    nextId: 100,
    drag: { kind: 'none' },
    mode: 'normal',
    status: '',
    reservedPanes: [],
    closedPanes: [],
  }
}

const CLOSED_STACK_LIMIT = 16

function captureCloseContext(node: PaneNode, paneId: string):
  | 'root'
  | { orientation: 'row' | 'column'; sourceFirst: boolean; siblingPaneIds: string[] }
  | null {
  if (node.kind === 'leaf') return node.id === paneId ? 'root' : null
  const [a, b] = node.children
  if (a.kind === 'leaf' && a.id === paneId) {
    return {
      orientation: node.orientation,
      sourceFirst: true,
      siblingPaneIds: collectPaneIds(b),
    }
  }
  if (b.kind === 'leaf' && b.id === paneId) {
    return {
      orientation: node.orientation,
      sourceFirst: false,
      siblingPaneIds: collectPaneIds(a),
    }
  }
  return captureCloseContext(a, paneId) ?? captureCloseContext(b, paneId)
}

function pushClosedPane(
  state: AppState,
  tab: Tab,
  pane: Pane,
): AppState {
  const ctx = captureCloseContext(tab.root, pane.id)
  if (!ctx) return state
  const entry: ClosedPaneEntry = {
    pane,
    tabId: tab.id,
    tabTitle: tab.title,
    wasSoleInTab: ctx === 'root',
    siblingPaneIds: ctx === 'root' ? [] : ctx.siblingPaneIds,
    orientation: ctx === 'root' ? 'row' : ctx.orientation,
    sourceFirst: ctx === 'root' ? true : ctx.sourceFirst,
  }
  const next = [...state.closedPanes, entry]
  if (next.length > CLOSED_STACK_LIMIT) next.splice(0, next.length - CLOSED_STACK_LIMIT)
  return { ...state, closedPanes: next }
}

export function reopenLastClosedPane(state: AppState): {
  state: AppState
  newPaneId: string | null
} {
  if (state.closedPanes.length === 0) {
    return { state: setStatus(state, 'nothing to reopen'), newPaneId: null }
  }
  const entry = state.closedPanes[state.closedPanes.length - 1]!
  const trimmed: AppState = {
    ...state,
    closedPanes: state.closedPanes.slice(0, -1),
  }

  const paneStep = nextId(trimmed, 'p')
  const newPane: Pane = {
    id: paneStep.id,
    title: entry.pane.title,
    accent: entry.pane.accent,
  }

  if (entry.wasSoleInTab) {
    const tabStep = nextId(paneStep.state, 't')
    const newTab: Tab = {
      id: tabStep.id,
      title: entry.tabTitle,
      focusedPaneId: newPane.id,
      root: { kind: 'leaf', id: newPane.id, pane: newPane },
    }
    return {
      state: {
        ...tabStep.state,
        tabs: [...tabStep.state.tabs, newTab],
        activeTabId: newTab.id,
        status: `reopened ${newPane.title}`,
      },
      newPaneId: newPane.id,
    }
  }

  const tab =
    paneStep.state.tabs.find(t => t.id === entry.tabId) ??
    activeTab(paneStep.state)
  const aliveIds = new Set(collectPaneIds(tab.root))
  const anchor =
    entry.siblingPaneIds.find(id => aliveIds.has(id)) ?? tab.focusedPaneId

  const splitStep = nextId(paneStep.state, 's')
  const sourceLeaf: PaneNode = { kind: 'leaf', id: newPane.id, pane: newPane }
  const newRoot = replacePane(tab.root, anchor, existing => ({
    kind: 'split',
    id: splitStep.id,
    orientation: entry.orientation,
    ratio: 0.5,
    children: entry.sourceFirst ? [sourceLeaf, existing] : [existing, sourceLeaf],
  }))

  return {
    state: {
      ...splitStep.state,
      tabs: splitStep.state.tabs.map(t =>
        t.id === tab.id ? { ...t, root: newRoot, focusedPaneId: newPane.id } : t,
      ),
      activeTabId: tab.id,
      status: `reopened ${newPane.title}`,
    },
    newPaneId: newPane.id,
  }
}

export function openContextMenu(
  state: AppState,
  target: ContextMenuTarget,
  x: number,
  y: number,
): AppState {
  return { ...state, contextMenu: { target, x, y, cursor: 0 } }
}

export function moveContextMenuCursor(state: AppState, cursor: number): AppState {
  if (!state.contextMenu) return state
  if (state.contextMenu.cursor === cursor) return state
  return { ...state, contextMenu: { ...state.contextMenu, cursor } }
}

export function closeContextMenu(state: AppState): AppState {
  if (!state.contextMenu) return state
  return { ...state, contextMenu: undefined }
}

export function setHoverPeek(state: AppState, peek: HoverPeek | null): AppState {
  if (peek === null) {
    if (!state.hoverPeek) return state
    return { ...state, hoverPeek: undefined }
  }
  if (state.hoverPeek && state.hoverPeek.tabId === peek.tabId) return state
  return { ...state, hoverPeek: peek }
}

export function toggleExpose(state: AppState): AppState {
  return { ...state, expose: !state.expose, hoverPeek: undefined, contextMenu: undefined }
}

export function exitExpose(state: AppState): AppState {
  if (!state.expose) return state
  return { ...state, expose: false }
}

const ACCENT_PALETTE = [81, 213, 156, 220, 207, 141, 117, 183, 110, 39]

function accentFor(index: number): number {
  return ACCENT_PALETTE[index % ACCENT_PALETTE.length]!
}

export function activeTab(state: AppState): Tab {
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? state.tabs[0]!
}

export function findPane(node: PaneNode, paneId: string): Pane | null {
  if (node.kind === 'leaf') {
    return node.id === paneId ? node.pane : null
  }
  return findPane(node.children[0], paneId) ?? findPane(node.children[1], paneId)
}

export function findPaneInTabs(state: AppState, paneId: string):
  | { tab: Tab; pane: Pane }
  | null {
  for (const tab of state.tabs) {
    const pane = findPane(tab.root, paneId)
    if (pane) {
      return { tab, pane }
    }
  }
  return null
}

export function collectPaneIds(node: PaneNode): string[] {
  if (node.kind === 'leaf') {
    return [node.id]
  }
  return [
    ...collectPaneIds(node.children[0]),
    ...collectPaneIds(node.children[1]),
  ]
}

function mapTab(state: AppState, tabId: string, updater: (tab: Tab) => Tab): AppState {
  return {
    ...state,
    tabs: state.tabs.map(tab => (tab.id === tabId ? updater(tab) : tab)),
  }
}

function nextId(state: AppState, prefix: string): { id: string; state: AppState } {
  const id = `${prefix}${state.nextId}`
  return { id, state: { ...state, nextId: state.nextId + 1 } }
}

export function splitActivePane(
  state: AppState,
  orientation: 'row' | 'column',
): AppState {
  const tab = activeTab(state)
  const focused = tab.focusedPaneId
  const existing = findPane(tab.root, focused)
  if (!existing) {
    return state
  }

  const paneStep = nextId(state, 'p')
  const splitStep = nextId(paneStep.state, 's')

  const newPane: Pane = makeScratchPane(paneStep.id)

  const updatedRoot = replacePane(tab.root, focused, current => ({
    kind: 'split',
    id: splitStep.id,
    orientation,
    ratio: 0.5,
    children: [current, { kind: 'leaf', id: newPane.id, pane: newPane }],
  }))

  const next = mapTab(splitStep.state, tab.id, t => ({
    ...t,
    root: updatedRoot,
    focusedPaneId: newPane.id,
  }))

  return {
    ...next,
    status: `split ${orientation === 'row' ? 'horizontally' : 'vertically'} · ${newPane.title}`,
  }
}

function makeScratchPane(id: string): Pane {
  const color = accentFor(Number.parseInt(id.slice(1), 10) || 0)
  return {
    id,
    title: 'shell',
    accent: color,
  }
}

export function closeActivePane(state: AppState): AppState {
  const tab = activeTab(state)
  return closePane(state, tab.focusedPaneId)
}

export function closePane(state: AppState, paneId: string): AppState {
  const info = findPaneInTabs(state, paneId)
  if (!info) {
    return state
  }

  const result = removePane(info.tab.root, paneId)
  if (result.status === 'unchanged') {
    return state
  }

  const stashed = pushClosedPane(state, info.tab, info.pane)

  if (result.status === 'emptied') {
    const remaining = stashed.tabs.filter(t => t.id !== info.tab.id)
    if (remaining.length === 0) {
      return { ...stashed, tabs: [], status: 'last pane closed' }
    }
    const activeTabId =
      stashed.activeTabId === info.tab.id ? remaining[0]!.id : stashed.activeTabId
    return {
      ...stashed,
      tabs: remaining,
      activeTabId,
      status: `closed tab ${info.tab.title}`,
    }
  }

  const nextFocus = result.nextFocusId ?? collectPaneIds(result.root)[0]!
  return {
    ...mapTab(stashed, info.tab.id, t => ({
      ...t,
      root: result.root,
      focusedPaneId: nextFocus,
    })),
    status: 'closed pane',
  }
}

export function ejectPane(state: AppState, paneId: string): AppState {
  const info = findPaneInTabs(state, paneId)
  if (!info) return state

  const result = removePane(info.tab.root, paneId)
  if (result.status === 'unchanged') return state

  const reserved = state.reservedPanes.includes(paneId)
    ? state.reservedPanes
    : [...state.reservedPanes, paneId]

  if (result.status === 'emptied') {
    const remaining = state.tabs.filter(t => t.id !== info.tab.id)
    if (remaining.length === 0) {
      return {
        ...state,
        tabs: [],
        reservedPanes: reserved,
        status: 'ejected last pane',
      }
    }
    const activeTabId =
      state.activeTabId === info.tab.id ? remaining[0]!.id : state.activeTabId
    return {
      ...state,
      tabs: remaining,
      activeTabId,
      reservedPanes: reserved,
      status: `ejected ${info.pane.title}`,
    }
  }

  const nextFocus = result.nextFocusId ?? collectPaneIds(result.root)[0]!
  return {
    ...mapTab({ ...state, reservedPanes: reserved }, info.tab.id, t => ({
      ...t,
      root: result.root,
      focusedPaneId: nextFocus,
    })),
    status: `ejected ${info.pane.title}`,
  }
}

export function releaseReservedPane(state: AppState, paneId: string): AppState {
  if (!state.reservedPanes.includes(paneId)) return state
  return {
    ...state,
    reservedPanes: state.reservedPanes.filter(id => id !== paneId),
  }
}

export function pruneReservedPanes(
  state: AppState,
  keep: (paneId: string) => boolean,
): AppState {
  const next = state.reservedPanes.filter(keep)
  if (next.length === state.reservedPanes.length) return state
  return { ...state, reservedPanes: next }
}

export function newTab(state: AppState): AppState {
  const paneStep = nextId(state, 'p')
  const tabStep = nextId(paneStep.state, 't')
  const pane = makeScratchPane(paneStep.id)
  const tab: Tab = {
    id: tabStep.id,
    title: `tab ${state.tabs.length + 1}`,
    focusedPaneId: pane.id,
    root: { kind: 'leaf', id: pane.id, pane },
  }
  return {
    ...tabStep.state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    status: `new tab ${tab.title}`,
  }
}

function updatePane(
  state: AppState,
  paneId: string,
  updater: (pane: Pane) => Pane,
): AppState {
  let touched = false
  const tabs = state.tabs.map(tab => {
    const nextRoot = mapPane(tab.root, paneId, pane => {
      const next = updater(pane)
      if (next !== pane) {
        touched = true
      }
      return next
    })
    return nextRoot === tab.root ? tab : { ...tab, root: nextRoot }
  })
  if (!touched) {
    return state
  }
  return { ...state, tabs }
}

function mapPane(
  node: PaneNode,
  paneId: string,
  updater: (pane: Pane) => Pane,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== paneId) {
      return node
    }
    const nextPane = updater(node.pane)
    return nextPane === node.pane ? node : { ...node, pane: nextPane }
  }
  const left = mapPane(node.children[0], paneId, updater)
  const right = mapPane(node.children[1], paneId, updater)
  if (left === node.children[0] && right === node.children[1]) {
    return node
  }
  return { ...node, children: [left, right] }
}

export function setPaneTitle(
  state: AppState,
  paneId: string,
  title: string,
): AppState {
  return updatePane(state, paneId, pane =>
    pane.title === title ? pane : { ...pane, title },
  )
}

export function focusTab(state: AppState, tabId: string): AppState {
  if (!state.tabs.some(t => t.id === tabId)) {
    return state
  }
  return { ...state, activeTabId: tabId, status: '' }
}

export function toggleZoom(state: AppState): AppState {
  const tab = activeTab(state)
  return mapTab(state, tab.id, t => ({
    ...t,
    zoomedPaneId: t.zoomedPaneId ? undefined : t.focusedPaneId,
  }))
}

export function toggleSynchronize(state: AppState): AppState {
  const tab = activeTab(state)
  const next = !tab.synchronize
  return mapTab({ ...state, status: next ? 'sync panes: on' : 'sync panes: off' }, tab.id, t => ({
    ...t,
    synchronize: next,
  }))
}

export function focusNextTab(state: AppState, step: number): AppState {
  const index = state.tabs.findIndex(t => t.id === state.activeTabId)
  if (index < 0) {
    return state
  }
  const next = (index + step + state.tabs.length) % state.tabs.length
  return { ...state, activeTabId: state.tabs[next]!.id }
}

export function focusPane(state: AppState, paneId: string): AppState {
  const found = findPaneInTabs(state, paneId)
  if (!found) {
    return state
  }
  return {
    ...state,
    activeTabId: found.tab.id,
    tabs: state.tabs.map(t =>
      t.id === found.tab.id ? { ...t, focusedPaneId: paneId } : t,
    ),
  }
}

export function cycleFocusedPane(state: AppState, step: number): AppState {
  const tab = activeTab(state)
  const ids = collectPaneIds(tab.root)
  const index = ids.indexOf(tab.focusedPaneId)
  if (index < 0) {
    return state
  }
  const next = (index + step + ids.length) % ids.length
  return mapTab(state, tab.id, t => ({ ...t, focusedPaneId: ids[next]! }))
}

export function renameActiveTab(state: AppState, title: string): AppState {
  return mapTab(state, state.activeTabId, t => ({ ...t, title }))
}

export function startPaneDrag(
  state: AppState,
  paneId: string,
  x: number,
  y: number,
  tabLayout: ReadonlyArray<{ id: string; x: number; width: number }> = [],
): AppState {
  const found = findPaneInTabs(state, paneId)
  if (!found) {
    return state
  }
  return {
    ...state,
    drag: {
      kind: 'pane',
      paneId,
      fromTabId: found.tab.id,
      paneTitle: found.pane.title,
      paneAccent: found.pane.accent,
      startX: x,
      startY: y,
      x,
      y,
      moved: false,
      tabLayout,
    },
  }
}

export function startTabDrag(
  state: AppState,
  tabId: string,
  x: number,
  y: number,
  tabLayout: ReadonlyArray<{ id: string; x: number; width: number }> = [],
): AppState {
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) {
    return state
  }
  return {
    ...state,
    drag: {
      kind: 'tab',
      tabId,
      tabTitle: tab.title,
      startX: x,
      startY: y,
      x,
      y,
      moved: false,
      tabLayout,
    },
  }
}

export function updateDrag(state: AppState, x: number, y: number): AppState {
  if (state.drag.kind === 'none') {
    return state
  }
  const dx = Math.abs(x - state.drag.startX)
  const dy = Math.abs(y - state.drag.startY)
  const moved = state.drag.moved || dx + dy >= 1

  if (state.drag.kind === 'resize') {
    const ratio = ratioFromCursor(state.drag, x, y)
    const retargeted = setSplitRatio(state, state.drag.splitId, ratio)
    return {
      ...retargeted,
      drag: { ...state.drag, x, y, moved },
      status: `resize ${state.drag.orientation === 'row' ? '↔' : '↕'} ${Math.round(ratio * 100)}%`,
    }
  }

  return { ...state, drag: { ...state.drag, x, y, moved } }
}

function ratioFromCursor(
  drag: Extract<DragState, { kind: 'resize' }>,
  x: number,
  y: number,
): number {
  const { bounds, orientation } = drag
  const raw =
    orientation === 'row'
      ? (x - bounds.x) / Math.max(1, bounds.width - 1)
      : (y - bounds.y) / Math.max(1, bounds.height - 1)
  return Math.max(0.1, Math.min(0.9, raw))
}

export function cancelDrag(state: AppState): AppState {
  if (state.drag.kind === 'none') {
    return state
  }
  if (state.drag.kind === 'resize') {
    const restored = setSplitRatio(state, state.drag.splitId, state.drag.startRatio)
    return { ...restored, drag: { kind: 'none' } }
  }
  return { ...state, drag: { kind: 'none' } }
}

export function startResizeDrag(
  state: AppState,
  splitId: string,
  bounds: ResizeBounds,
  x: number,
  y: number,
): AppState {
  const found = findSplitById(state, splitId)
  if (!found) return state
  return {
    ...state,
    drag: {
      kind: 'resize',
      splitId,
      orientation: found.orientation,
      bounds,
      startRatio: found.ratio,
      startX: x,
      startY: y,
      x,
      y,
      moved: false,
    },
    status: `resize ${found.orientation === 'row' ? '↔' : '↕'} ${Math.round(found.ratio * 100)}%`,
  }
}

function findSplitById(
  state: AppState,
  splitId: string,
): { orientation: 'row' | 'column'; ratio: number } | null {
  for (const tab of state.tabs) {
    const hit = findSplitNode(tab.root, splitId)
    if (hit) return { orientation: hit.orientation, ratio: hit.ratio }
  }
  return null
}

function findSplitNode(
  node: PaneNode,
  splitId: string,
): Extract<PaneNode, { kind: 'split' }> | null {
  if (node.kind === 'leaf') return null
  if (node.id === splitId) return node
  return (
    findSplitNode(node.children[0], splitId) ??
    findSplitNode(node.children[1], splitId)
  )
}

function setSplitRatio(state: AppState, splitId: string, ratio: number): AppState {
  let touched = false
  const tabs = state.tabs.map(tab => {
    const nextRoot = mapSplitRatio(tab.root, splitId, ratio, () => {
      touched = true
    })
    return nextRoot === tab.root ? tab : { ...tab, root: nextRoot }
  })
  if (!touched) return state
  return { ...state, tabs }
}

function mapSplitRatio(
  node: PaneNode,
  splitId: string,
  ratio: number,
  onMatch: () => void,
): PaneNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) {
    if (node.ratio === ratio) return node
    onMatch()
    return { ...node, ratio }
  }
  const left = mapSplitRatio(node.children[0], splitId, ratio, onMatch)
  const right = mapSplitRatio(node.children[1], splitId, ratio, onMatch)
  if (left === node.children[0] && right === node.children[1]) return node
  return { ...node, children: [left, right] }
}

export type SplitDirection = 'left' | 'right' | 'top' | 'bottom'

export type DropTarget =
  | { kind: 'pane'; paneId: string; direction: SplitDirection }
  | { kind: 'tab'; tabId: string; insertIndex: number }
  | { kind: 'tabbar'; insertIndex: number }
  | { kind: 'none' }

export function endDrag(state: AppState, target: DropTarget): AppState {
  const drag = state.drag
  if (drag.kind === 'none') {
    return state
  }

  if (drag.kind === 'resize') {
    const current =
      findSplitById(state, drag.splitId)?.ratio ?? drag.startRatio
    const ratioPct = Math.round(current * 100)
    return {
      ...state,
      drag: { kind: 'none' },
      status: drag.moved
        ? `resized ${drag.orientation === 'row' ? '↔' : '↕'} to ${ratioPct}%`
        : state.status,
    }
  }

  if (!drag.moved) {
    if (drag.kind === 'pane') {
      return {
        ...focusPane(state, drag.paneId),
        drag: { kind: 'none' },
        status: `focused ${drag.paneTitle}`,
      }
    }
    return {
      ...focusTab(state, drag.tabId),
      drag: { kind: 'none' },
      status: '',
    }
  }

  if (drag.kind === 'pane') {
    return dropPane(state, drag.paneId, drag.fromTabId, target)
  }
  return dropTab(state, drag.tabId, target)
}

function dropPane(
  state: AppState,
  paneId: string,
  fromTabId: string,
  target: DropTarget,
): AppState {
  const cleared: AppState = { ...state, drag: { kind: 'none' } }

  if (target.kind === 'pane') {
    if (target.paneId === paneId) {
      return cleared
    }
    return dockPaneIntoPane(cleared, paneId, fromTabId, target.paneId, target.direction)
  }

  if (target.kind === 'tab') {
    if (target.tabId === fromTabId) {
      return cleared
    }
    return movePaneToTab(cleared, paneId, fromTabId, target.tabId)
  }

  if (target.kind === 'tabbar') {
    return promotePaneToTab(cleared, paneId, fromTabId, target.insertIndex)
  }

  return cleared
}

function dropTab(
  state: AppState,
  tabId: string,
  target: DropTarget,
): AppState {
  const cleared: AppState = { ...state, drag: { kind: 'none' } }

  if (target.kind === 'pane') {
    return foldTabIntoPane(cleared, tabId, target.paneId, target.direction)
  }
  if (target.kind === 'tab' || target.kind === 'tabbar') {
    return reorderTab(cleared, tabId, target.insertIndex)
  }
  return cleared
}

function dockPaneIntoPane(
  state: AppState,
  sourcePaneId: string,
  fromTabId: string,
  targetPaneId: string,
  direction: SplitDirection,
): AppState {
  const sourceInfo = findPaneInTabs(state, sourcePaneId)
  const targetInfo = findPaneInTabs(state, targetPaneId)
  if (!sourceInfo || !targetInfo) return state
  if (sourcePaneId === targetPaneId) return state

  const orientation: 'row' | 'column' =
    direction === 'left' || direction === 'right' ? 'row' : 'column'
  const sourceFirst = direction === 'left' || direction === 'top'

  const splitStep = nextId(state, 's')
  const sourceLeaf: PaneNode = {
    kind: 'leaf',
    id: sourcePaneId,
    pane: sourceInfo.pane,
  }
  const makeSplit = (targetLeaf: PaneNode): PaneNode => ({
    kind: 'split',
    id: splitStep.id,
    orientation,
    ratio: 0.5,
    children: sourceFirst ? [sourceLeaf, targetLeaf] : [targetLeaf, sourceLeaf],
  })

  if (sourceInfo.tab.id === targetInfo.tab.id) {
    const removal = removePane(sourceInfo.tab.root, sourcePaneId)
    if (removal.status !== 'pruned') return state
    const newRoot = replacePane(removal.root, targetPaneId, makeSplit)
    return {
      ...splitStep.state,
      tabs: splitStep.state.tabs.map(t =>
        t.id === sourceInfo.tab.id
          ? { ...t, root: newRoot, focusedPaneId: sourcePaneId }
          : t,
      ),
      status: `docked ${sourceInfo.pane.title} ${dockVerb(direction)} ${targetInfo.pane.title}`,
    }
  }

  const removal = removePane(sourceInfo.tab.root, sourcePaneId)
  if (removal.status === 'unchanged') return state

  const targetNewRoot = replacePane(targetInfo.tab.root, targetPaneId, makeSplit)
  const tabs = splitStep.state.tabs
    .map(tab => {
      if (tab.id === targetInfo.tab.id) {
        return { ...tab, root: targetNewRoot, focusedPaneId: sourcePaneId }
      }
      if (tab.id === sourceInfo.tab.id) {
        if (removal.status === 'emptied') return null
        return {
          ...tab,
          root: removal.root,
          focusedPaneId:
            removal.nextFocusId ?? collectPaneIds(removal.root)[0]!,
        }
      }
      return tab
    })
    .filter((t): t is Tab => t !== null)

  const activeTabId =
    removal.status === 'emptied' && state.activeTabId === sourceInfo.tab.id
      ? targetInfo.tab.id
      : state.activeTabId

  return {
    ...splitStep.state,
    tabs,
    activeTabId,
    status: `docked ${sourceInfo.pane.title} ${dockVerb(direction)} ${targetInfo.pane.title}`,
  }
}

export function dockVerb(direction: SplitDirection): string {
  switch (direction) {
    case 'left':
      return 'left of'
    case 'right':
      return 'right of'
    case 'top':
      return 'above'
    case 'bottom':
      return 'below'
  }
}

function movePaneToTab(
  state: AppState,
  paneId: string,
  fromTabId: string,
  toTabId: string,
): AppState {
  const source = state.tabs.find(t => t.id === fromTabId)
  const destination = state.tabs.find(t => t.id === toTabId)
  if (!source || !destination) {
    return state
  }

  const removal = removePane(source.root, paneId)
  if (removal.status !== 'pruned' && removal.status !== 'emptied') {
    return state
  }

  const pane = findPane(source.root, paneId)
  if (!pane) {
    return state
  }

  const leaf: PaneNode = { kind: 'leaf', id: paneId, pane }
  const splitStep = nextId(state, 's')
  const destRoot: PaneNode = {
    kind: 'split',
    id: splitStep.id,
    orientation: 'row',
    ratio: 0.5,
    children: [destination.root, leaf],
  }

  let tabs = splitStep.state.tabs.map(tab => {
    if (tab.id === toTabId) {
      return { ...tab, root: destRoot, focusedPaneId: paneId }
    }
    if (tab.id === fromTabId) {
      if (removal.status === 'emptied') {
        return null
      }
      const nextFocus = removal.nextFocusId ?? collectPaneIds(removal.root)[0]!
      return { ...tab, root: removal.root, focusedPaneId: nextFocus }
    }
    return tab
  }).filter((tab): tab is Tab => tab !== null)

  const activeTabId =
    removal.status === 'emptied' && state.activeTabId === fromTabId
      ? toTabId
      : state.activeTabId

  return {
    ...splitStep.state,
    tabs,
    activeTabId,
    status: `moved ${pane.title} → ${destination.title}`,
  }
}

function promotePaneToTab(
  state: AppState,
  paneId: string,
  fromTabId: string,
  insertIndex: number,
): AppState {
  const source = state.tabs.find(t => t.id === fromTabId)
  if (!source) {
    return state
  }
  const pane = findPane(source.root, paneId)
  if (!pane) {
    return state
  }

  if (source.root.kind === 'leaf' && state.tabs.length === 1) {
    return { ...state, status: 'cannot empty the last tab' }
  }

  const removal = removePane(source.root, paneId)
  const tabStep = nextId(state, 't')
  const newTabEntry: Tab = {
    id: tabStep.id,
    title: pane.title,
    focusedPaneId: paneId,
    root: { kind: 'leaf', id: paneId, pane },
  }

  const sourceIdx = state.tabs.findIndex(t => t.id === fromTabId)
  const kept: Tab[] = []
  for (const tab of tabStep.state.tabs) {
    if (tab.id !== fromTabId) {
      kept.push(tab)
      continue
    }
    if (removal.status === 'pruned') {
      kept.push({
        ...tab,
        root: removal.root,
        focusedPaneId:
          removal.nextFocusId ?? collectPaneIds(removal.root)[0]!,
      })
    }
  }

  const sourceRemoved = removal.status === 'emptied'
  const adjusted = sourceRemoved && insertIndex > sourceIdx
    ? insertIndex - 1
    : insertIndex
  const clamped = Math.max(0, Math.min(kept.length, adjusted))

  const tabs = [...kept]
  tabs.splice(clamped, 0, newTabEntry)

  return {
    ...tabStep.state,
    tabs,
    activeTabId: newTabEntry.id,
    status: `promoted ${pane.title} to its own tab`,
  }
}

function foldTabIntoPane(
  state: AppState,
  tabId: string,
  targetPaneId: string,
  direction: SplitDirection,
): AppState {
  if (state.tabs.length <= 1) {
    return { ...state, status: 'need at least one remaining tab' }
  }
  const sourceTab = state.tabs.find(t => t.id === tabId)
  const targetInfo = findPaneInTabs(state, targetPaneId)
  if (!sourceTab || !targetInfo) {
    return state
  }
  if (targetInfo.tab.id === tabId) {
    return state
  }

  const orientation: 'row' | 'column' =
    direction === 'left' || direction === 'right' ? 'row' : 'column'
  const sourceFirst = direction === 'left' || direction === 'top'

  const splitStep = nextId(state, 's')
  const newRoot = replacePane(targetInfo.tab.root, targetPaneId, leaf => ({
    kind: 'split',
    id: splitStep.id,
    orientation,
    ratio: 0.5,
    children: sourceFirst ? [sourceTab.root, leaf] : [leaf, sourceTab.root],
  }))

  const tabs = splitStep.state.tabs
    .filter(tab => tab.id !== tabId)
    .map(tab =>
      tab.id === targetInfo.tab.id
        ? { ...tab, root: newRoot, focusedPaneId: collectPaneIds(sourceTab.root)[0]! }
        : tab,
    )

  const activeTabId =
    state.activeTabId === tabId ? targetInfo.tab.id : state.activeTabId

  return {
    ...splitStep.state,
    tabs,
    activeTabId,
    status: `docked ${sourceTab.title} ${dockVerb(direction)} ${targetInfo.pane.title}`,
  }
}

function reorderTab(state: AppState, draggedId: string, insertIndex: number): AppState {
  const from = state.tabs.findIndex(t => t.id === draggedId)
  if (from < 0) {
    return state
  }
  const adjusted = insertIndex > from ? insertIndex - 1 : insertIndex
  const clamped = Math.max(0, Math.min(state.tabs.length - 1, adjusted))
  if (clamped === from) {
    return state
  }
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(from, 1)
  tabs.splice(clamped, 0, moved!)
  return { ...state, tabs, status: `moved ${moved!.title}` }
}

function replacePane(
  node: PaneNode,
  paneId: string,
  replacement: (leaf: PaneNode) => PaneNode,
): PaneNode {
  if (node.kind === 'leaf') {
    return node.id === paneId ? replacement(node) : node
  }
  const left = replacePane(node.children[0], paneId, replacement)
  const right = replacePane(node.children[1], paneId, replacement)
  if (left === node.children[0] && right === node.children[1]) {
    return node
  }
  return { ...node, children: [left, right] }
}

type RemoveResult =
  | { status: 'unchanged'; root: PaneNode }
  | { status: 'emptied' }
  | { status: 'pruned'; root: PaneNode; nextFocusId?: string }

function removePane(node: PaneNode, paneId: string): RemoveResult {
  if (node.kind === 'leaf') {
    if (node.id !== paneId) {
      return { status: 'unchanged', root: node }
    }
    return { status: 'emptied' }
  }

  const [left, right] = node.children
  const leftResult = removePane(left, paneId)
  if (leftResult.status === 'emptied') {
    return { status: 'pruned', root: right, nextFocusId: collectPaneIds(right)[0] }
  }
  if (leftResult.status === 'pruned') {
    return {
      status: 'pruned',
      root: { ...node, children: [leftResult.root, right] },
      nextFocusId: leftResult.nextFocusId,
    }
  }

  const rightResult = removePane(right, paneId)
  if (rightResult.status === 'emptied') {
    return { status: 'pruned', root: left, nextFocusId: collectPaneIds(left)[0] }
  }
  if (rightResult.status === 'pruned') {
    return {
      status: 'pruned',
      root: { ...node, children: [left, rightResult.root] },
      nextFocusId: rightResult.nextFocusId,
    }
  }

  return { status: 'unchanged', root: node }
}

export function setStatus(state: AppState, status: string): AppState {
  return { ...state, status }
}

export function setMode(state: AppState, mode: CommandMode): AppState {
  return { ...state, mode }
}

export function startTabRename(state: AppState, tabId: string): AppState {
  const base = state.renaming ? commitTabRename(state) : state
  const tab = base.tabs.find(t => t.id === tabId)
  if (!tab) return base
  return {
    ...base,
    renaming: { tabId, buffer: tab.title },
    status: 'rename tab · enter saves · esc cancels · ctrl+u clears',
  }
}

export function appendTabRename(state: AppState, char: string): AppState {
  if (!state.renaming) return state
  if (state.renaming.buffer.length >= 64) return state
  return {
    ...state,
    renaming: {
      ...state.renaming,
      buffer: state.renaming.buffer + char,
    },
  }
}

export function backspaceTabRename(state: AppState): AppState {
  if (!state.renaming) return state
  const chars = Array.from(state.renaming.buffer)
  if (chars.length === 0) return state
  return {
    ...state,
    renaming: {
      ...state.renaming,
      buffer: chars.slice(0, -1).join(''),
    },
  }
}

export function clearTabRenameBuffer(state: AppState): AppState {
  if (!state.renaming) return state
  return {
    ...state,
    renaming: { ...state.renaming, buffer: '' },
  }
}

export function cancelTabRename(state: AppState): AppState {
  if (!state.renaming) return state
  return {
    ...state,
    renaming: undefined,
    status: 'rename cancelled',
  }
}

export function commitTabRename(state: AppState): AppState {
  if (!state.renaming) return state
  const { tabId, buffer } = state.renaming
  const trimmed = buffer.trim()
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) {
    return { ...state, renaming: undefined }
  }
  if (!trimmed || trimmed === tab.title) {
    return {
      ...state,
      renaming: undefined,
      status: trimmed ? '' : 'rename cancelled (blank)',
    }
  }
  return {
    ...state,
    tabs: state.tabs.map(t => (t.id === tabId ? { ...t, title: trimmed } : t)),
    renaming: undefined,
    status: `renamed tab → "${trimmed}"`,
  }
}

const HISTORY_LIMIT = 50

function cloneNode(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return { ...node, pane: { ...node.pane } }
  return {
    ...node,
    children: [cloneNode(node.children[0]), cloneNode(node.children[1])],
  }
}

function cloneTab(tab: Tab): Tab {
  return { ...tab, root: cloneNode(tab.root) }
}

export function layoutSnapshot(state: AppState): LayoutSnapshot {
  return {
    tabs: state.tabs.map(cloneTab),
    activeTabId: state.activeTabId,
    nextId: state.nextId,
  }
}

export function structurallyEqual(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  if (a.activeTabId !== b.activeTabId) return false
  if (a.nextId !== b.nextId) return false
  if (a.tabs.length !== b.tabs.length) return false
  for (let i = 0; i < a.tabs.length; i++) {
    if (!tabsEqual(a.tabs[i]!, b.tabs[i]!)) return false
  }
  return true
}

function tabsEqual(a: Tab, b: Tab): boolean {
  if (a.id !== b.id) return false
  if (a.title !== b.title) return false
  if (a.focusedPaneId !== b.focusedPaneId) return false
  if (a.zoomedPaneId !== b.zoomedPaneId) return false
  if (!!a.synchronize !== !!b.synchronize) return false
  return nodesEqual(a.root, b.root)
}

function nodesEqual(a: PaneNode, b: PaneNode): boolean {
  if (a.kind !== b.kind) return false
  if (a.id !== b.id) return false
  if (a.kind === 'leaf' && b.kind === 'leaf') {
    return a.pane.id === b.pane.id && a.pane.title === b.pane.title
  }
  if (a.kind === 'split' && b.kind === 'split') {
    if (a.orientation !== b.orientation) return false
    if (a.ratio !== b.ratio) return false
    return nodesEqual(a.children[0], b.children[0]) && nodesEqual(a.children[1], b.children[1])
  }
  return false
}

export function recordHistory(prev: AppState, next: AppState): AppState {
  const prevSnap = layoutSnapshot(prev)
  const nextSnap = layoutSnapshot(next)
  if (structurallyEqual(prevSnap, nextSnap)) return next
  const past = (next.history?.past ?? []).concat(prevSnap).slice(-HISTORY_LIMIT)
  return { ...next, history: { past, future: [] } }
}

function restoreSnapshot(state: AppState, snap: LayoutSnapshot): AppState {
  return {
    ...state,
    tabs: snap.tabs.map(cloneTab),
    activeTabId: snap.activeTabId,
    nextId: snap.nextId,
    drag: { kind: 'none' },
    renaming: undefined,
    contextMenu: undefined,
    hoverPeek: undefined,
    sessionPicker: undefined,
    expose: false,
  }
}

export function undoLayout(state: AppState): AppState {
  const past = state.history?.past ?? []
  if (past.length === 0) return setStatus(state, 'undo: nothing to undo')
  const snap = past[past.length - 1]!
  const restored = restoreSnapshot(state, snap)
  const future = [layoutSnapshot(state), ...(state.history?.future ?? [])].slice(0, HISTORY_LIMIT)
  return {
    ...restored,
    history: { past: past.slice(0, -1), future },
    status: 'undo',
  }
}

export function redoLayout(state: AppState): AppState {
  const future = state.history?.future ?? []
  if (future.length === 0) return setStatus(state, 'redo: nothing to redo')
  const snap = future[0]!
  const restored = restoreSnapshot(state, snap)
  const past = [...(state.history?.past ?? []), layoutSnapshot(state)].slice(-HISTORY_LIMIT)
  return {
    ...restored,
    history: { past, future: future.slice(1) },
    status: 'redo',
  }
}
