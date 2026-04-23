import type { Overlay, PaintFn, ViewNode } from './runtime.js'
import {
  activeTab,
  collectPaneIds,
  dockVerb,
  findPane,
  findPaneInTabs,
  type AppState,
  type ContextMenuState,
  type Pane,
  type PaneNode,
  type SessionPickerEntry,
  type SessionPickerState,
  type SplitDirection,
  type Tab,
} from './wm.js'

export type PanePaintLookup = (paneId: string) => PaintFn | null

export type SplitPreview = {
  paneId: string
  direction: SplitDirection
  ghostRect: { x: number; y: number; width: number; height: number }
  sourceTitle: string
  sourceAccent: number
}

export type DropPreview = {
  splitPreview?: SplitPreview
  highlightTabId?: string
  tabReorder?: {
    tabId: string
    toIndex: number
  }
  tabPromote?: {
    insertIndex: number
    title: string
    accent: number
  }
  actionLabel?: string
}

const COLOR = {
  bg: 234,
  surface: 236,
  border: 239,
  borderFocus: 117,
  text: 250,
  textMuted: 244,
  textDim: 240,
  accent: 117,
  accentBg: 24,
  drop: 117,
  dropBg: 235,
  ghostBg: 235,
  ghostFg: 250,
  dragFadeFg: 241,
  dragFadeBg: 234,
  statusBg: 235,
  statusFg: 246,
  activity: 220,
  syncFg: 214,
  menuBg: 237,
  menuBgActive: 24,
  menuFg: 250,
  menuFgMuted: 244,
  menuBorder: 117,
  peekBg: 235,
  peekBorder: 117,
  peekHeaderFg: 250,
  whichKeyBg: 236,
  whichKeyBorder: 117,
  whichKeyFg: 250,
  whichKeyAccent: 117,
  exposeBg: 233,
  exposeCardBg: 236,
  exposeBorder: 240,
  exposeBorderActive: 117,
}

export type ViewResult = {
  root: ViewNode
  overlays: Overlay[]
}

export type HoverPeekAnchor = { x: number; width: number }

export function computePeekRect(
  anchor: HoverPeekAnchor,
  columns: number,
  rows: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(columns - 2, Math.max(50, Math.floor(columns * 0.55)))
  const height = Math.min(rows - 4, Math.max(15, Math.floor(rows * 0.65)))
  let x = anchor.x + Math.floor(anchor.width / 2) - Math.floor(width / 2)
  x = Math.max(1, Math.min(columns - width - 1, x))
  const y = 2
  return { x, y, width, height }
}

export type BuildViewOpts = {
  paintForPane?: PanePaintLookup
  thumbnailForPane?: PanePaintLookup
  preview?: DropPreview | null
  activityPanes?: ReadonlySet<string>
  hoverPeekAnchor?: HoverPeekAnchor | null
  graphicsPeek?: boolean
}

export function buildView(
  state: AppState,
  columns: number,
  rows: number,
  opts: BuildViewOpts = {},
): ViewResult {
  const paintForPane = opts.paintForPane ?? (() => null)
  const thumbnailForPane = opts.thumbnailForPane ?? (() => null)
  const preview = opts.preview ?? null
  const activityPanes = opts.activityPanes ?? new Set<string>()
  const hoverPeekAnchor = opts.hoverPeekAnchor ?? null
  const graphicsPeek = opts.graphicsPeek === true

  const tab = activeTab(state)

  const paneArea = state.expose
    ? buildExposeArea(state, thumbnailForPane)
    : buildPaneArea(tab, state, paintForPane, preview, activityPanes)

  const root: ViewNode = {
    style: {
      width: columns,
      height: rows,
      flexDirection: 'column',
    },
    fillChar: ' ',
    appearance: { fill: { bg: state.expose ? COLOR.exposeBg : COLOR.bg } },
    children: [
      buildTabBar(state, preview, activityPanes),
      paneArea,
      buildStatusBar(state, preview),
    ],
  }

  const overlays: Overlay[] = []
  if (preview?.splitPreview) {
    overlays.push(buildSplitGhost(preview.splitPreview))
  }
  const ghost = buildDragGhost(state, columns, rows)
  if (ghost) {
    overlays.push(ghost)
  }

  if (state.mode === 'prefix' && !state.expose) {
    overlays.push(buildWhichKeyOverlay(columns, rows))
  }

  if (state.hoverPeek && hoverPeekAnchor && !state.expose && state.drag.kind === 'none') {
    const peek = buildHoverPeekOverlay(
      state,
      hoverPeekAnchor,
      columns,
      rows,
      thumbnailForPane,
      graphicsPeek,
    )
    if (peek) overlays.push(peek)
  }

  if (state.contextMenu) {
    overlays.push(buildContextMenuOverlay(state, state.contextMenu, columns, rows))
  }

  if (state.sessionPicker) {
    overlays.push(buildSessionPickerOverlay(state.sessionPicker, state.sessionName ?? 'default', columns, rows))
  }

  return { root, overlays }
}

function buildTabBar(
  state: AppState,
  preview: DropPreview | null,
  activityPanes: ReadonlySet<string>,
): ViewNode {
  const draggedTabId = state.drag.kind === 'tab' ? state.drag.tabId : null
  const renamingTabId = state.renaming?.tabId ?? null
  const tabOrder = applyTabReorder(state.tabs, preview?.tabReorder ?? null)
  const tabChips: ViewNode[] = tabOrder.map(tab => {
    const isActiveTab = tab.id === state.activeTabId
    const hasActivity =
      !isActiveTab && collectPaneIds(tab.root).some(id => activityPanes.has(id))
    return buildTabChip(
      tab,
      isActiveTab,
      preview?.highlightTabId === tab.id,
      draggedTabId === tab.id && state.drag.kind === 'tab' && state.drag.moved,
      renamingTabId === tab.id ? state.renaming!.buffer : null,
      hasActivity,
      !!tab.synchronize,
    )
  })

  const children: ViewNode[] = [...tabChips]
  if (preview?.tabPromote) {
    const insertAt = Math.max(0, Math.min(children.length, preview.tabPromote.insertIndex))
    children.splice(insertAt, 0, buildGhostTabChip(preview.tabPromote.title))
  }
  children.push(buildNewTabButton())

  return {
    id: 'tabbar',
    style: {
      height: 1,
      flexDirection: 'row',
      alignItems: 'stretch',
      paddingX: 1,
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.surface } },
    children,
  }
}

function buildGhostTabChip(title: string): ViewNode {
  const label = ` ${title} `
  const width = Math.max(6, Math.min(22, Array.from(label).length))
  return {
    style: { width, height: 1 },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.dropBg } },
    children: [
      {
        text: label,
        textAlign: 'center',
        style: { height: 1 },
        appearance: { text: { fg: COLOR.drop, bg: COLOR.dropBg, bold: true } },
      },
    ],
  }
}

function buildTabChip(
  tab: Tab,
  isActive: boolean,
  isDropTarget: boolean,
  isDragSource: boolean,
  renameBuffer: string | null,
  hasActivity: boolean,
  isSynchronized: boolean,
): ViewNode {
  const isRenaming = renameBuffer !== null
  const marker = hasActivity ? '• ' : isSynchronized && isActive ? '⇅ ' : ''
  const displayText = isRenaming
    ? formatRenameLabel(renameBuffer!)
    : `${marker}${tab.title}`
  const label = ` ${displayText} `
  const maxW = isRenaming ? 32 : 22
  const width = Math.max(6, Math.min(maxW, Array.from(label).length))

  const bg = isRenaming
    ? COLOR.accentBg
    : isDropTarget
      ? COLOR.dropBg
      : isDragSource
        ? COLOR.dragFadeBg
        : isActive
          ? COLOR.accentBg
          : COLOR.surface
  const fg = isRenaming
    ? COLOR.text
    : isDropTarget
      ? COLOR.drop
      : isDragSource
        ? COLOR.dragFadeFg
        : isActive
          ? COLOR.text
          : hasActivity
            ? COLOR.activity
            : COLOR.textMuted
  const bold = isActive || isRenaming || isDropTarget || hasActivity

  return {
    id: `tab:${tab.id}`,
    style: { width, height: 1 },
    fillChar: ' ',
    appearance: { fill: { bg } },
    children: [
      {
        text: label,
        textAlign: 'center',
        style: { height: 1 },
        appearance: { text: { fg, bg, bold } },
      },
    ],
  }
}

function applyTabReorder(
  tabs: readonly Tab[],
  reorder: DropPreview['tabReorder'] | null,
): readonly Tab[] {
  if (!reorder) return tabs
  const fromIdx = tabs.findIndex(t => t.id === reorder.tabId)
  if (fromIdx < 0) return tabs
  const next = tabs.slice()
  const [moved] = next.splice(fromIdx, 1)
  const toIdx = Math.max(0, Math.min(next.length, reorder.toIndex))
  next.splice(toIdx, 0, moved!)
  return next
}

function formatRenameLabel(buffer: string): string {
  const cursor = '▎'
  const chars = Array.from(buffer)
  if (chars.length <= 25) {
    return `${buffer}${cursor}`
  }
  return `…${chars.slice(-24).join('')}${cursor}`
}

function buildNewTabButton(): ViewNode {
  return {
    id: 'tab-new',
    style: { width: 3, height: 1 },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.surface } },
    children: [
      {
        text: ' + ',
        textAlign: 'center',
        style: { height: 1 },
        appearance: { text: { fg: COLOR.accent, bg: COLOR.surface, bold: true } },
      },
    ],
  }
}

function buildPaneArea(
  tab: Tab,
  state: AppState,
  paintForPane: PanePaintLookup,
  preview: DropPreview | null,
  activityPanes: ReadonlySet<string>,
): ViewNode {
  const root = tab.zoomedPaneId
    ? (findPaneLeaf(tab.root, tab.zoomedPaneId) ?? tab.root)
    : tab.root
  return {
    style: {
      flexGrow: 1,
      flexDirection: 'column',
      paddingX: 1,
      paddingBottom: 1,
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.bg } },
    children: [renderPaneNode(root, tab, state, paintForPane, preview, activityPanes)],
  }
}

function findPaneLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null
  for (const child of node.children) {
    const found = findPaneLeaf(child, paneId)
    if (found) return found
  }
  return null
}

function renderPaneNode(
  node: PaneNode,
  tab: Tab,
  state: AppState,
  paintForPane: PanePaintLookup,
  preview: DropPreview | null,
  activityPanes: ReadonlySet<string>,
): ViewNode {
  if (node.kind === 'leaf') {
    return renderPaneLeaf(node.pane, tab, state, paintForPane, preview, activityPanes)
  }

  const leftGrow = Math.max(1, Math.round(node.ratio * 100))
  const rightGrow = Math.max(1, 100 - leftGrow)
  const isResizing =
    state.drag.kind === 'resize' && state.drag.splitId === node.id

  return {
    id: `split:${node.id}`,
    style: {
      flexGrow: 1,
      flexDirection: node.orientation,
    },
    children: [
      withGrow(
        renderPaneNode(node.children[0], tab, state, paintForPane, preview, activityPanes),
        leftGrow,
      ),
      buildResizeHandle(node.id, node.orientation, isResizing),
      withGrow(
        renderPaneNode(node.children[1], tab, state, paintForPane, preview, activityPanes),
        rightGrow,
      ),
    ],
  }
}

function buildResizeHandle(
  splitId: string,
  orientation: 'row' | 'column',
  isResizing: boolean,
): ViewNode {
  const isRow = orientation === 'row'
  const char = isResizing ? (isRow ? '┃' : '━') : isRow ? '│' : '─'
  const fg = isResizing ? COLOR.accent : COLOR.border

  return {
    id: `split-handle:${splitId}`,
    style: isRow ? { width: 1, flexShrink: 0 } : { height: 1, flexShrink: 0 },
    fillChar: char,
    appearance: { fill: { fg, bg: COLOR.bg, bold: isResizing } },
  }
}

function withGrow(node: ViewNode, grow: number): ViewNode {
  return {
    ...node,
    style: { ...(node.style ?? {}), flexGrow: grow, flexShrink: 1 },
  }
}

function renderPaneLeaf(
  pane: Pane,
  tab: Tab,
  state: AppState,
  paintForPane: PanePaintLookup,
  preview: DropPreview | null,
  activityPanes: ReadonlySet<string>,
): ViewNode {
  const isFocused = pane.id === tab.focusedPaneId && tab.id === state.activeTabId
  const isDragSource =
    state.drag.kind === 'pane' && state.drag.paneId === pane.id && state.drag.moved
  const isDropTarget = preview?.splitPreview?.paneId === pane.id
  const hasActivity = !isFocused && activityPanes.has(pane.id)
  const isSynchronized = !!tab.synchronize
  const paint = paintForPane(pane.id)

  return {
    id: `pane:${pane.id}`,
    style: {
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: 'column',
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.bg } },
    children: [
      buildPaneHeader(pane, isFocused, isDragSource, isDropTarget, hasActivity, isSynchronized),
      {
        style: { flexGrow: 1 },
        fillChar: ' ',
        appearance: { fill: { bg: COLOR.bg } },
        paint: paint ?? undefined,
      },
    ],
  }
}

function buildPaneHeader(
  pane: Pane,
  isFocused: boolean,
  isDragSource: boolean,
  isDropTarget: boolean,
  hasActivity: boolean,
  isSynchronized: boolean,
): ViewNode {
  const fg = isDropTarget
    ? COLOR.drop
    : isDragSource
      ? COLOR.dragFadeFg
      : isFocused
        ? COLOR.text
        : hasActivity
          ? COLOR.activity
          : COLOR.textMuted
  const dotFg = isFocused
    ? COLOR.accent
    : hasActivity
      ? COLOR.activity
      : COLOR.textDim
  const syncBadge = isSynchronized ? ' ⇅' : ''

  return {
    id: `pane-header:${pane.id}`,
    style: {
      height: 1,
      flexDirection: 'row',
      paddingX: 1,
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.bg } },
    children: [
      {
        style: { width: 2, height: 1 },
        fillChar: ' ',
        text: '● ',
        appearance: {
          fill: { bg: COLOR.bg },
          text: { fg: dotFg, bg: COLOR.bg, bold: hasActivity },
        },
      },
      {
        style: { flexGrow: 1, height: 1 },
        fillChar: ' ',
        text: `${pane.title}${syncBadge}`,
        textAlign: 'left',
        appearance: {
          fill: { bg: COLOR.bg },
          text: { fg, bg: COLOR.bg, bold: isFocused || hasActivity },
        },
      },
    ],
  }
}

function buildStatusBar(state: AppState, preview: DropPreview | null): ViewNode {
  const leftText = leftStatusText(state, preview)
  const rightText = rightStatusText(state)
  const emphasis = preview !== null || state.mode === 'prefix' || !!state.renaming

  return {
    style: {
      height: 1,
      flexDirection: 'row',
      paddingX: 1,
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.statusBg } },
    children: [
      {
        text: leftText,
        style: { flexGrow: 1, height: 1 },
        appearance: {
          text: {
            fg: emphasis ? COLOR.accent : COLOR.statusFg,
            bg: COLOR.statusBg,
            bold: emphasis,
          },
        },
      },
      {
        text: rightText,
        style: { width: Math.max(20, Array.from(rightText).length + 1), height: 1 },
        textAlign: 'right',
        appearance: {
          text: { fg: COLOR.textDim, bg: COLOR.statusBg },
        },
      },
    ],
  }
}

function leftStatusText(state: AppState, preview: DropPreview | null): string {
  if (state.renaming) {
    return 'rename · enter saves · esc cancels'
  }
  if (state.mode === 'prefix') {
    return 'prefix · %  " split · c tab · x close · n/p cycle · q quit'
  }
  if (state.drag.kind === 'resize') {
    return state.status || 'resize'
  }
  if (preview) {
    const label = previewActionLabel(state, preview)
    if (label) return label
  }
  return state.status || ''
}

function rightStatusText(state: AppState): string {
  if (state.renaming || state.drag.kind !== 'none') {
    return ''
  }
  const session = state.sessionName ?? 'default'
  const sessionChip = `⧉ ${session}`
  if (state.sessionRenaming) {
    const draft = state.sessionRenaming.buffer || '…'
    return `⧉ ${draft}▎ (enter: save · esc: cancel)`
  }
  if (state.mode === 'prefix') {
    return sessionChip
  }
  return `${sessionChip}  ·  ctrl+b  ?`
}

function arrowFor(direction: SplitDirection): string {
  switch (direction) {
    case 'left':
      return '←'
    case 'right':
      return '→'
    case 'top':
      return '↑'
    case 'bottom':
      return '↓'
  }
}

function buildSplitGhost(split: SplitPreview): Overlay {
  const { ghostRect, direction, sourceTitle } = split
  const { x, y, width, height } = ghostRect
  const label = `${arrowFor(direction)} ${sourceTitle}`
  const border =
    width >= 2 && height >= 2 ? ('dashed' as const) : ('none' as const)

  return {
    x,
    y,
    width,
    height,
    node: {
      style: {
        width,
        height,
        flexDirection: 'column',
        justifyContent: 'center',
      },
      border,
      fillChar: ' ',
      appearance: {
        fill: { bg: COLOR.dropBg },
        border: { fg: COLOR.drop, bg: COLOR.dropBg, bold: true },
        text: { fg: COLOR.drop, bg: COLOR.dropBg, bold: true },
      },
      children: [
        {
          text: label,
          textAlign: 'center',
          textVerticalAlign: 'middle',
          style: { height: 1 },
        },
      ],
    },
  }
}

function previewActionLabel(
  state: AppState,
  preview: DropPreview | null,
): string | null {
  if (state.drag.kind === 'none' || !state.drag.moved) {
    return null
  }
  if (state.drag.kind === 'resize') {
    return null
  }
  if (preview?.actionLabel) {
    return preview.actionLabel
  }
  if (!preview) {
    return null
  }

  const source =
    state.drag.kind === 'tab'
      ? `tab "${state.drag.tabTitle}"`
      : `pane "${state.drag.paneTitle}"`

  if (preview.splitPreview) {
    const info = findPaneInTabs(state, preview.splitPreview.paneId)
    if (!info) return null
    return `dock ${source} ${dockVerb(preview.splitPreview.direction)} "${info.pane.title}"`
  }

  if (preview.highlightTabId) {
    const tab = state.tabs.find(t => t.id === preview.highlightTabId)
    if (!tab) return null
    return `move ${source} into "${tab.title}"`
  }

  if (preview.tabReorder) {
    return `reorder ${source}`
  }

  if (preview.tabPromote) {
    return `promote ${source} to a new tab`
  }

  return null
}

const WHICH_KEY_ITEMS: Array<{ key: string; label: string }> = [
  { key: '%', label: 'split right' },
  { key: '"', label: 'split down' },
  { key: 'c', label: 'new tab' },
  { key: 'x', label: 'close pane' },
  { key: 'T', label: 'reopen closed' },
  { key: '=', label: 'exposé' },
  { key: 'z', label: 'zoom toggle' },
  { key: 'e', label: 'eject to tab' },
  { key: 'S', label: 'sync panes' },
  { key: '/', label: 'search' },
  { key: 'n', label: 'next tab' },
  { key: 'p', label: 'prev tab' },
  { key: '1-9', label: 'jump to tab' },
  { key: '←↑↓→', label: 'cycle focus' },
  { key: 's', label: 'sessions' },
  { key: '$', label: 'rename session' },
  { key: 'u', label: 'undo layout' },
  { key: 'U', label: 'redo layout' },
  { key: 'd', label: 'detach' },
  { key: 'q', label: 'quit' },
]

function buildWhichKeyOverlay(columns: number, rows: number): Overlay {
  const cols = 2
  const perCol = Math.ceil(WHICH_KEY_ITEMS.length / cols)
  const colWidths = Array.from({ length: cols }, (_, c) => {
    let maxKey = 0
    let maxLabel = 0
    for (let r = 0; r < perCol; r++) {
      const item = WHICH_KEY_ITEMS[c * perCol + r]
      if (!item) continue
      maxKey = Math.max(maxKey, Array.from(item.key).length)
      maxLabel = Math.max(maxLabel, Array.from(item.label).length)
    }
    return { key: maxKey, label: maxLabel }
  })

  const colRenderWidth = (w: { key: number; label: number }) => w.key + 2 + w.label
  const innerWidth =
    colWidths.reduce((acc, w) => acc + colRenderWidth(w), 0) +
    Math.max(0, cols - 1) * 3
  const boxWidth = Math.min(columns - 2, innerWidth + 4)
  const boxHeight = perCol + 2 + 2 + 2
  const overlayX = Math.max(1, Math.floor((columns - boxWidth) / 2))
  const overlayY = Math.max(1, rows - boxHeight - 2)

  const rowsChildren: ViewNode[] = []
  const title: ViewNode = {
    text: 'prefix — press a key',
    textAlign: 'center',
    style: { height: 1 },
    appearance: {
      text: { fg: COLOR.whichKeyAccent, bg: COLOR.whichKeyBg, bold: true },
    },
  }
  rowsChildren.push(title)
  rowsChildren.push({
    style: { height: 1 },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.whichKeyBg } },
  })

  for (let r = 0; r < perCol; r++) {
    const cells: ViewNode[] = []
    for (let c = 0; c < cols; c++) {
      const item = WHICH_KEY_ITEMS[c * perCol + r]
      const width = colRenderWidth(colWidths[c]!)
      if (!item) {
        cells.push({
          style: { width, height: 1 },
          fillChar: ' ',
          appearance: { fill: { bg: COLOR.whichKeyBg } },
        })
      } else {
        const keyStr = item.key.padEnd(colWidths[c]!.key, ' ')
        cells.push({
          style: { width, height: 1, flexDirection: 'row' },
          fillChar: ' ',
          appearance: { fill: { bg: COLOR.whichKeyBg } },
          children: [
            {
              text: keyStr,
              style: { width: colWidths[c]!.key, height: 1 },
              appearance: {
                text: { fg: COLOR.whichKeyAccent, bg: COLOR.whichKeyBg, bold: true },
              },
            },
            {
              text: '  ',
              style: { width: 2, height: 1 },
              appearance: { text: { fg: COLOR.whichKeyFg, bg: COLOR.whichKeyBg } },
            },
            {
              text: item.label,
              style: { width: colWidths[c]!.label, height: 1 },
              appearance: { text: { fg: COLOR.whichKeyFg, bg: COLOR.whichKeyBg } },
            },
          ],
        })
      }
      if (c < cols - 1) {
        cells.push({
          style: { width: 3, height: 1 },
          fillChar: ' ',
          appearance: { fill: { bg: COLOR.whichKeyBg } },
        })
      }
    }
    rowsChildren.push({
      style: { height: 1, flexDirection: 'row' },
      fillChar: ' ',
      appearance: { fill: { bg: COLOR.whichKeyBg } },
      children: cells,
    })
  }

  return {
    x: overlayX,
    y: overlayY,
    width: boxWidth,
    height: boxHeight,
    node: {
      style: {
        width: boxWidth,
        height: boxHeight,
        flexDirection: 'column',
        padding: 1,
      },
      border: 'accent',
      fillChar: ' ',
      appearance: {
        fill: { bg: COLOR.whichKeyBg },
        border: { fg: COLOR.whichKeyBorder, bg: COLOR.whichKeyBg, bold: true },
      },
      children: rowsChildren,
    },
  }
}

function buildHoverPeekOverlay(
  state: AppState,
  anchor: HoverPeekAnchor,
  columns: number,
  rows: number,
  thumbnailForPane: PanePaintLookup,
  graphicsMode: boolean,
): Overlay | null {
  const peek = state.hoverPeek
  if (!peek) return null
  const tab = state.tabs.find(t => t.id === peek.tabId)
  if (!tab) return null

  const { x, y, width, height } = computePeekRect(anchor, columns, rows)

  const paneCount = collectPaneIds(tab.root).length
  const header: ViewNode = {
    style: { height: 1, flexDirection: 'row' },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.peekBg } },
    children: [
      {
        text: ` ${tab.title}`,
        style: { flexGrow: 1, height: 1 },
        appearance: {
          text: { fg: COLOR.peekHeaderFg, bg: COLOR.peekBg, bold: true },
        },
      },
      {
        text: `${paneCount} pane${paneCount === 1 ? '' : 's'} `,
        textAlign: 'right',
        style: { width: 10, height: 1 },
        appearance: { text: { fg: COLOR.textDim, bg: COLOR.peekBg } },
      },
    ],
  }
  const divider: ViewNode = {
    style: { height: 1 },
    fillChar: '─',
    appearance: { fill: { fg: COLOR.border, bg: COLOR.peekBg } },
  }

  return {
    x,
    y,
    width,
    height,
    node: {
      style: { width, height, flexDirection: 'column', padding: 0 },
      border: 'accent',
      fillChar: ' ',
      appearance: {
        fill: { bg: COLOR.peekBg },
        border: { fg: COLOR.peekBorder, bg: COLOR.peekBg, bold: true },
      },
      children: [
        header,
        divider,
        renderPeekPaneNode(tab.root, thumbnailForPane, graphicsMode),
      ],
    },
  }
}

function renderPeekPaneNode(
  node: PaneNode,
  thumbnailForPane: PanePaintLookup,
  graphicsMode: boolean,
): ViewNode {
  if (node.kind === 'leaf') {
    const paint = graphicsMode ? null : thumbnailForPane(node.id)
    return {
      style: { flexGrow: 1, flexShrink: 1 },
      fillChar: ' ',
      appearance: { fill: { bg: COLOR.peekBg } },
      paint: paint ?? undefined,
    }
  }
  const leftGrow = Math.max(1, Math.round(node.ratio * 100))
  const rightGrow = Math.max(1, 100 - leftGrow)
  const left = renderPeekPaneNode(node.children[0], thumbnailForPane, graphicsMode)
  const right = renderPeekPaneNode(node.children[1], thumbnailForPane, graphicsMode)
  return {
    style: { flexGrow: 1, flexShrink: 1, flexDirection: node.orientation },
    children: [
      { ...left, style: { ...(left.style ?? {}), flexGrow: leftGrow, flexShrink: 1 } },
      {
        style: node.orientation === 'row' ? { width: 1 } : { height: 1 },
        fillChar: node.orientation === 'row' ? '│' : '─',
        appearance: { fill: { fg: COLOR.border, bg: COLOR.peekBg } },
      },
      { ...right, style: { ...(right.style ?? {}), flexGrow: rightGrow, flexShrink: 1 } },
    ],
  }
}

export type ContextMenuItem = {
  action: string
  label: string
  accelerator?: string
  muted?: boolean
}

export function contextMenuItemsFor(
  state: AppState,
  menu: ContextMenuState,
): ContextMenuItem[] {
  const target = menu.target
  if (target.kind === 'pane') {
    const info = findPaneInTabs(state, target.paneId)
    if (!info) return []
    const zoomed = info.tab.zoomedPaneId === info.pane.id
    return [
      { action: 'split-right', label: 'Split right', accelerator: '%' },
      { action: 'split-down', label: 'Split down', accelerator: '"' },
      { action: 'zoom', label: zoomed ? 'Unzoom' : 'Zoom', accelerator: 'z' },
      { action: 'eject', label: 'Move to new tab', accelerator: 'e' },
      { action: 'close', label: 'Close pane', accelerator: 'x' },
    ]
  }
  const tabId = target.tabId
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) return []
  return [
    { action: 'new', label: 'New tab', accelerator: 'c' },
    { action: 'rename', label: 'Rename tab' },
    { action: 'sync', label: tab.synchronize ? 'Turn sync off' : 'Turn sync on' },
    { action: 'eject', label: 'Eject tab', accelerator: 'E' },
    { action: 'close', label: 'Close tab' },
  ]
}

function buildContextMenuOverlay(
  state: AppState,
  menu: ContextMenuState,
  columns: number,
  rows: number,
): Overlay {
  const items = contextMenuItemsFor(state, menu)
  const labels = items.map(i => i.label)
  const accels = items.map(i => i.accelerator ?? '')
  const labelW = labels.reduce((m, l) => Math.max(m, Array.from(l).length), 0)
  const accelW = accels.reduce((m, a) => Math.max(m, Array.from(a).length), 0)
  const innerWidth = labelW + (accelW > 0 ? accelW + 3 : 0)
  const width = Math.min(columns - 2, innerWidth + 4)
  const height = items.length + 2
  let x = menu.x
  let y = menu.y
  if (x + width > columns - 1) x = Math.max(1, columns - width - 1)
  if (y + height > rows - 1) y = Math.max(1, rows - height - 1)

  const itemNodes: ViewNode[] = items.map((item, index) => {
    const active = index === menu.cursor
    const bg = active ? COLOR.menuBgActive : COLOR.menuBg
    const fg = item.muted ? COLOR.menuFgMuted : COLOR.menuFg
    const leftPad = ' '
    const rightPad = ' '
    const labelCell: ViewNode = {
      text: `${leftPad}${item.label}`,
      style: { flexGrow: 1, height: 1 },
      appearance: { text: { fg, bg, bold: active } },
    }
    const accel = item.accelerator
    const children: ViewNode[] = [labelCell]
    if (accel) {
      children.push({
        text: `${accel}${rightPad}`,
        textAlign: 'right',
        style: { width: accelW + 1, height: 1 },
        appearance: {
          text: { fg: active ? COLOR.text : COLOR.textDim, bg, bold: false },
        },
      })
    }
    return {
      id: `ctx-item:${item.action}`,
      style: { height: 1, flexDirection: 'row' },
      fillChar: ' ',
      appearance: { fill: { bg } },
      children,
    }
  })

  return {
    x,
    y,
    width,
    height,
    node: {
      id: 'ctx-menu',
      style: { width, height, flexDirection: 'column' },
      border: 'accent',
      fillChar: ' ',
      appearance: {
        fill: { bg: COLOR.menuBg },
        border: { fg: COLOR.menuBorder, bg: COLOR.menuBg, bold: true },
      },
      children: itemNodes,
    },
  }
}

type ExposeCard = {
  tab: Tab
  pane: Pane
  isActiveTab: boolean
  isFocusedPane: boolean
}

function collectExposeCards(state: AppState): ExposeCard[] {
  const cards: ExposeCard[] = []
  for (const tab of state.tabs) {
    const isActiveTab = tab.id === state.activeTabId
    for (const paneId of collectPaneIds(tab.root)) {
      const pane = findPane(tab.root, paneId)
      if (!pane) continue
      cards.push({
        tab,
        pane,
        isActiveTab,
        isFocusedPane: isActiveTab && tab.focusedPaneId === paneId,
      })
    }
  }
  return cards
}

function buildExposeArea(
  state: AppState,
  thumbnailForPane: PanePaintLookup,
): ViewNode {
  const cards = collectExposeCards(state)
  if (cards.length === 0) {
    return {
      style: { flexGrow: 1 },
      fillChar: ' ',
      appearance: { fill: { bg: COLOR.exposeBg } },
    }
  }
  const gridCols = cards.length <= 2 ? cards.length : Math.ceil(Math.sqrt(cards.length))
  const gridRows = Math.ceil(cards.length / gridCols)
  const rowsNodes: ViewNode[] = []
  for (let r = 0; r < gridRows; r++) {
    const rowCards = cards.slice(r * gridCols, (r + 1) * gridCols)
    const rowChildren: ViewNode[] = rowCards.map(card =>
      buildExposeCard(card, thumbnailForPane),
    )
    while (rowChildren.length < gridCols) {
      rowChildren.push({
        style: { flexGrow: 1, flexShrink: 1 },
        fillChar: ' ',
        appearance: { fill: { bg: COLOR.exposeBg } },
      })
    }
    rowsNodes.push({
      style: {
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: 'row',
        gap: 1,
      },
      children: rowChildren,
    })
  }
  return {
    style: {
      flexGrow: 1,
      flexDirection: 'column',
      padding: 1,
      gap: 1,
    },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.exposeBg } },
    children: rowsNodes,
  }
}

function buildExposeCard(card: ExposeCard, thumbnailForPane: PanePaintLookup): ViewNode {
  const paint = thumbnailForPane(card.pane.id) ?? undefined
  const borderColor = card.isFocusedPane ? COLOR.exposeBorderActive : COLOR.exposeBorder
  const fg = card.isFocusedPane ? COLOR.text : COLOR.textMuted
  const label = `${card.tab.title} · ${card.pane.title}`
  return {
    id: `expose:${card.pane.id}`,
    style: {
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: 'column',
    },
    border: 'accent',
    fillChar: ' ',
    appearance: {
      fill: { bg: COLOR.exposeCardBg },
      border: { fg: borderColor, bg: COLOR.exposeCardBg, bold: card.isFocusedPane },
    },
    children: [
      {
        style: { height: 1, flexDirection: 'row' },
        fillChar: ' ',
        appearance: { fill: { bg: COLOR.exposeCardBg } },
        children: [
          {
            text: ` ${label}`,
            style: { flexGrow: 1, height: 1 },
            appearance: { text: { fg, bg: COLOR.exposeCardBg, bold: card.isFocusedPane } },
          },
        ],
      },
      {
        style: { flexGrow: 1 },
        fillChar: ' ',
        appearance: { fill: { bg: COLOR.exposeCardBg } },
        paint,
      },
    ],
  }
}

function buildDragGhost(
  state: AppState,
  columns: number,
  rows: number,
): Overlay | null {
  if (state.drag.kind === 'none' || !state.drag.moved) {
    return null
  }
  if (state.drag.kind === 'resize') {
    return null
  }

  const { x, y } = state.drag
  const title =
    state.drag.kind === 'pane'
      ? state.drag.paneTitle
      : state.drag.tabTitle

  const label = ` ${title} `
  const width = Math.max(12, Array.from(label).length + 2)
  const height = 1

  const overlayX = clamp(x - Math.floor(width / 2), 0, columns - width)
  const overlayY =
    y < 1 ? clamp(1, 0, rows - height) : clamp(y, 0, rows - height)

  return {
    x: overlayX,
    y: overlayY,
    width,
    height,
    node: {
      style: { width, height },
      fillChar: ' ',
      appearance: {
        fill: { bg: COLOR.accentBg },
        text: { fg: COLOR.text, bg: COLOR.accentBg, bold: true },
      },
      children: [
        {
          text: label,
          textAlign: 'center',
          textVerticalAlign: 'middle',
          style: { height: 1 },
        },
      ],
    },
  }
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) {
    return lo
  }
  if (value < lo) {
    return lo
  }
  if (value > hi) {
    return hi
  }
  return value
}

export function filterSessionEntries(
  entries: readonly SessionPickerEntry[],
  filter: string,
): SessionPickerEntry[] {
  if (!filter) return [...entries]
  const q = filter.toLowerCase()
  const scored: Array<{ entry: SessionPickerEntry; score: number }> = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    if (name === q) {
      scored.push({ entry, score: 0 })
      continue
    }
    if (name.startsWith(q)) {
      scored.push({ entry, score: 1 })
      continue
    }
    if (name.includes(q)) {
      scored.push({ entry, score: 2 })
      continue
    }
    const sub = subsequenceScore(name, q)
    if (sub >= 0) scored.push({ entry, score: 10 + sub })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.map(s => s.entry)
}

function subsequenceScore(haystack: string, needle: string): number {
  let hi = 0
  let last = -1
  let gaps = 0
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]!
    const found = haystack.indexOf(ch, hi)
    if (found < 0) return -1
    if (last >= 0) gaps += found - last - 1
    last = found
    hi = found + 1
  }
  return gaps
}

function relativeTime(lastMs: number): string {
  if (!lastMs) return 'never'
  const delta = Date.now() - lastMs
  if (delta < 1000) return 'now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  return `${day}d`
}

function buildSessionPickerOverlay(
  picker: SessionPickerState,
  activeSession: string,
  columns: number,
  rows: number,
): Overlay {
  const visible = filterSessionEntries(picker.entries, picker.filter)
  const boxWidth = Math.min(columns - 4, Math.max(54, Math.floor(columns * 0.6)))
  const maxListRows = Math.max(4, Math.min(14, rows - 10))
  const boxHeight = 5 + maxListRows + 3
  const overlayX = Math.max(1, Math.floor((columns - boxWidth) / 2))
  const overlayY = Math.max(1, Math.floor((rows - boxHeight) / 2))

  const header: ViewNode = {
    text: ' sessions ',
    style: { height: 1 },
    textAlign: 'center',
    appearance: {
      text: { fg: COLOR.accent, bg: COLOR.menuBg, bold: true },
    },
  }

  const filterLabel =
    picker.mode === 'browse'
      ? picker.filter
        ? `filter: ${picker.filter}_`
        : 'type to filter  ·  enter attach  ·  n new  ·  r rename  ·  d kill  ·  esc close'
      : picker.mode === 'create'
        ? `new session: ${picker.draftName}_`
        : picker.mode === 'rename'
          ? `rename → ${picker.draftName}_`
          : `kill "${picker.draftName}"? (y/n)`
  const filterRow: ViewNode = {
    style: { height: 1, paddingX: 1 },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.menuBg } },
    children: [
      {
        text: filterLabel,
        style: { flexGrow: 1, height: 1 },
        appearance: {
          text: {
            fg: picker.mode === 'browse' ? COLOR.textMuted : COLOR.accent,
            bg: COLOR.menuBg,
            bold: picker.mode !== 'browse',
          },
        },
      },
    ],
  }

  const rowsList: ViewNode[] = []
  if (visible.length === 0) {
    rowsList.push({
      text: picker.filter ? `no sessions match "${picker.filter}"` : '(no sessions)',
      textAlign: 'center',
      style: { height: 1 },
      appearance: { text: { fg: COLOR.textDim, bg: COLOR.menuBg } },
    })
  } else {
    const cursor = clamp(picker.cursor, 0, visible.length - 1)
    const windowStart = clamp(
      cursor - Math.floor(maxListRows / 2),
      0,
      Math.max(0, visible.length - maxListRows),
    )
    for (let i = 0; i < maxListRows; i++) {
      const idx = windowStart + i
      const entry = visible[idx]
      if (!entry) {
        rowsList.push({
          style: { height: 1 },
          fillChar: ' ',
          appearance: { fill: { bg: COLOR.menuBg } },
        })
        continue
      }
      const isCursor = idx === cursor
      const isActive = entry.name === activeSession
      const bg = isCursor ? COLOR.menuBgActive : COLOR.menuBg
      const nameFg = isCursor
        ? COLOR.text
        : isActive
          ? COLOR.accent
          : COLOR.menuFg
      const dim = isCursor ? COLOR.menuFg : COLOR.textDim
      const marker = isActive ? '●' : ' '
      const panes = `${entry.paneCount}p`
      const clients = entry.attached > 0 ? `${entry.attached}c` : ''
      const active = relativeTime(entry.lastActiveMs)
      const right = `${panes.padStart(4)}  ${clients.padStart(3)}  ${active.padStart(5)}`
      rowsList.push({
        style: { height: 1, flexDirection: 'row', paddingX: 1 },
        fillChar: ' ',
        appearance: { fill: { bg } },
        children: [
          {
            text: `${marker} `,
            style: { width: 2, height: 1 },
            appearance: {
              text: { fg: isActive ? COLOR.accent : dim, bg, bold: isActive },
            },
          },
          {
            text: entry.name,
            style: { flexGrow: 1, height: 1 },
            appearance: {
              text: { fg: nameFg, bg, bold: isCursor || isActive },
            },
          },
          {
            text: right,
            style: { width: Array.from(right).length, height: 1 },
            textAlign: 'right',
            appearance: { text: { fg: dim, bg } },
          },
        ],
      })
    }
  }

  const footer: ViewNode = {
    style: { height: 1, paddingX: 1 },
    fillChar: ' ',
    appearance: { fill: { bg: COLOR.menuBg } },
    children: [
      {
        text: picker.lastError
          ? `⚠ ${picker.lastError}`
          : `${visible.length} of ${picker.entries.length} session${picker.entries.length === 1 ? '' : 's'}`,
        style: { flexGrow: 1, height: 1 },
        appearance: {
          text: {
            fg: picker.lastError ? COLOR.activity : COLOR.textDim,
            bg: COLOR.menuBg,
          },
        },
      },
    ],
  }

  const node: ViewNode = {
    style: {
      width: boxWidth,
      height: boxHeight,
      flexDirection: 'column',
      padding: 1,
    },
    border: 'accent',
    fillChar: ' ',
    appearance: {
      fill: { bg: COLOR.menuBg },
      border: { fg: COLOR.menuBorder, bg: COLOR.menuBg, bold: true },
    },
    children: [
      header,
      { style: { height: 1 }, fillChar: ' ', appearance: { fill: { bg: COLOR.menuBg } } },
      filterRow,
      { style: { height: 1 }, fillChar: ' ', appearance: { fill: { bg: COLOR.menuBg } } },
      ...rowsList,
      { style: { height: 1 }, fillChar: ' ', appearance: { fill: { bg: COLOR.menuBg } } },
      footer,
    ],
  }

  return {
    x: overlayX,
    y: overlayY,
    width: boxWidth,
    height: boxHeight,
    node,
  }
}
