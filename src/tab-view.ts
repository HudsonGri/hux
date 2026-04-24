import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { renderView, type HitRegion, type PaintFn } from './runtime.js'
import { buildView } from './view.js'
import { IpcClient } from './ipc-client.js'
import { PATHS } from './ipc.js'
import { TerminalSession } from './terminal.js'
import { collectPaneIds, type AppState, type PaneNode, type Tab } from './wm.js'
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  CLEAR_SCREEN,
  RESET,
} from './terminal-escapes.js'
import { beginFrame, endFrame } from './frame-writer.js'
import { probeTerminalCaps } from './terminal-probe.js'

export type TabViewBlob = {
  v: 1
  title: string
  root: PaneNode
  focusedPaneId: string
}

export function encodeTabViewBlob(input: {
  title: string
  root: PaneNode
  focusedPaneId: string
}): string {
  const blob: TabViewBlob = { v: 1, ...input }
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')
}

export function decodeTabViewBlob(b64: string): TabViewBlob {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch (e) {
    throw new Error(`malformed --layout64: ${(e as Error).message}`)
  }
  const blob = decoded as Partial<TabViewBlob>
  if (!blob || blob.v !== 1 || typeof blob.title !== 'string' || !blob.root || !blob.focusedPaneId) {
    throw new Error('--layout64 is not a valid tab-view blob')
  }
  return blob as TabViewBlob
}

export async function runTabView(b64: string): Promise<void> {
  let blob: TabViewBlob
  try {
    blob = decodeTabViewBlob(b64)
  } catch (e) {
    console.error(`hux tab-view: ${(e as Error).message}`)
    process.exit(2)
  }

  if (!existsSync(PATHS.socket)) {
    console.error('hux tab-view: no running hux server')
    process.exit(1)
  }

  const ipc = new IpcClient()
  try {
    await ipc.connect()
    await ipc.hello()
  } catch (e) {
    console.error(`hux tab-view: ${(e as Error).message}`)
    process.exit(1)
  }

  const paneIds = collectPaneIds(blob.root)
  if (paneIds.length === 0) {
    console.error('hux tab-view: empty layout')
    ipc.close()
    process.exit(2)
  }

  const { panes } = await ipc.listPanes()
  for (const pid of paneIds) {
    const info = panes.find(p => p.id === pid)
    if (!info) {
      console.error(`hux tab-view: pane ${pid} not found on server`)
      ipc.close()
      process.exit(1)
    }
    if (!info.alive) {
      console.error(`hux tab-view: pane ${pid} has already exited`)
      ipc.close()
      process.exit(info.exit_code ?? 1)
    }
  }

  const tab: Tab = {
    id: 'view-tab',
    title: blob.title,
    root: blob.root,
    focusedPaneId: blob.focusedPaneId,
  }
  let state: AppState = {
    tabs: [tab],
    activeTabId: tab.id,
    nextId: 1000,
    drag: { kind: 'none' },
    mode: 'normal',
    status: `tab-view · ${blob.title} · ctrl-b q to quit, ctrl-b arrows to switch pane`,
    reservedPanes: [],
    closedPanes: [],
  }

  const sessions = new Map<string, TerminalSession>()
  for (const pid of paneIds) {
    const grid = await ipc.getGrid(pid).catch(() => null)
    if (!grid) {
      console.error(`hux tab-view: could not fetch grid for ${pid}`)
      ipc.close()
      process.exit(1)
    }
    const session = new TerminalSession({
      id: pid,
      shell: '',
      shellArgs: [],
      cwd: '',
      cols: grid.cols,
      rows: grid.rows,
      client: ipc,
      seedGrid: {
        cells: grid.cells,
        cursor_x: grid.cursor_x,
        cursor_y: grid.cursor_y,
        cols: grid.cols,
        rows: grid.rows,
        alternate_screen: grid.alternate_screen,
        mouse_protocol: grid.mouse_protocol,
      },
      callbacks: {
        onUpdate: () => scheduleRender(),
        onExit: () => {
          sessions.delete(pid)
          if (sessions.size === 0) {
            finish(0)
          } else {
            scheduleRender()
          }
        },
      },
    })
    sessions.set(pid, session)
  }

  let cleanedUp = false
  function cleanup(): void {
    if (cleanedUp) return
    cleanedUp = true
    for (const s of sessions.values()) s.detach()
    try { ipc.close() } catch {}
    process.stdout.write(`${RESET}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`)
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false) } catch {}
    }
    process.stdin.pause()
  }
  function finish(code: number): void {
    cleanup()
    process.exit(code)
  }
  process.on('exit', cleanup)
  process.on('SIGHUP', () => finish(129))
  process.on('SIGTERM', () => finish(143))

  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  await probeTerminalCaps()

  process.stdin.resume()
  process.stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}`)

  let renderScheduled = false
  function scheduleRender(): void {
    if (renderScheduled || cleanedUp) return
    renderScheduled = true
    setImmediate(() => {
      renderScheduled = false
      if (cleanedUp) return
      render()
    })
  }

  const paintForPane = (paneId: string): PaintFn | null => {
    const s = sessions.get(paneId)
    if (!s) return null
    return paneId === state.tabs[0]!.focusedPaneId
      ? s.paintWithCursorMarker
      : s.paintInto
  }

  const lastSize = new Map<string, { cols: number; rows: number }>()
  function render(): void {
    const cols = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const { root, overlays } = buildView(state, cols, rows, { paintForPane })
    const { output, hitRegions } = renderView(root, cols, rows, {
      color: true,
      overlays,
    })
    propagateResize(hitRegions)
    process.stdout.write(beginFrame() + output + endFrame(HIDE_CURSOR))
  }

  function propagateResize(regions: HitRegion[]): void {
    for (const region of regions) {
      const match = /^pane:(.+)$/.exec(region.id)
      if (!match) continue
      const paneId = match[1]!
      const session = sessions.get(paneId)
      if (!session) continue
      const prev = lastSize.get(paneId)
      if (prev && prev.cols === region.width && prev.rows === region.height) continue
      lastSize.set(paneId, { cols: region.width, rows: region.height })
      session.resize(region.width, region.height)
    }
  }

  scheduleRender()
  process.stdout.on('resize', () => scheduleRender())

  // Minimal prefix handler: Ctrl-B q to quit, Ctrl-B arrow to cycle focus.
  // Everything else in prefix mode is swallowed. Arrow sequences that
  // straddle stdin chunks aren't handled here; in raw mode the kernel
  // almost always delivers ESC [ X as a single 3-byte read.
  let inPrefix = false
  process.stdin.on('data', chunk => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const forwarded: Buffer[] = []
    let flushStart = 0
    let i = 0
    while (i < data.length) {
      const b = data[i]!
      if (inPrefix) {
        inPrefix = false
        if (b === 0x71 /* q */) {
          finish(0)
          return
        }
        if (b === 0x1b /* ESC */ && data[i + 1] === 0x5b /* [ */ && i + 2 < data.length) {
          cycleFocus(data[i + 2]!)
          i += 3
          flushStart = i
          continue
        }
        i += 1
        flushStart = i
        continue
      }
      if (b === 0x02 /* Ctrl-B */) {
        if (i > flushStart) forwarded.push(data.subarray(flushStart, i))
        inPrefix = true
        i += 1
        flushStart = i
        continue
      }
      i += 1
    }
    if (data.length > flushStart) forwarded.push(data.subarray(flushStart, data.length))
    if (forwarded.length === 0) return
    const out = Buffer.concat(forwarded).toString('utf8')
    const focused = state.tabs[0]!.focusedPaneId
    const session = sessions.get(focused)
    if (session) session.write(out)
  })

  function cycleFocus(arrow: number): void {
    const ids = collectPaneIds(state.tabs[0]!.root).filter(id => sessions.has(id))
    if (ids.length <= 1) return
    const current = state.tabs[0]!.focusedPaneId
    const idx = ids.indexOf(current)
    if (idx < 0) return
    let next = idx
    if (arrow === 0x43 /* right */ || arrow === 0x42 /* down */) {
      next = (idx + 1) % ids.length
    } else if (arrow === 0x44 /* left */ || arrow === 0x41 /* up */) {
      next = (idx - 1 + ids.length) % ids.length
    } else {
      return
    }
    if (next === idx) return
    state = {
      ...state,
      tabs: [{ ...state.tabs[0]!, focusedPaneId: ids[next]! }],
    }
    scheduleRender()
  }

  ipc.on('close', () => {
    if (!cleanedUp) finish(1)
  })

  await new Promise<void>(() => {})
}
