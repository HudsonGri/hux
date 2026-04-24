import { existsSync } from 'node:fs'
import { IpcClient } from './ipc-client.js'
import { PATHS, type Cell } from './ipc.js'
import { TerminalSession } from './terminal.js'
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  RESET,
} from './terminal-escapes.js'
import { beginFrame, endFrame } from './frame-writer.js'
import { probeTerminalCaps } from './terminal-probe.js'

const RGB_FLAG = 0x01000000

export async function runPaneView(paneId: string): Promise<void> {
  if (!existsSync(PATHS.socket)) {
    console.error('hux pane-view: no running hux server')
    process.exit(1)
  }

  const ipc = new IpcClient()
  try {
    await ipc.connect()
    await ipc.hello()
  } catch (e) {
    console.error(`hux pane-view: ${(e as Error).message}`)
    process.exit(1)
  }

  const { panes } = await ipc.listPanes()
  const info = panes.find(p => p.id === paneId)
  if (!info) {
    console.error(`hux pane-view: pane ${paneId} not found`)
    ipc.close()
    process.exit(1)
  }
  if (!info.alive) {
    console.error(`hux pane-view: pane ${paneId} has already exited`)
    ipc.close()
    process.exit(info.exit_code ?? 1)
  }

  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  await ipc.resize(paneId, cols, rows).catch(() => {})

  const initial = await ipc.getGrid(paneId)

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    process.stdout.write(`${RESET}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`)
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false) } catch {}
    }
    process.stdin.pause()
  }
  process.on('exit', cleanup)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  await probeTerminalCaps()

  process.stdin.resume()
  process.stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`)

  let paintScheduled = false
  let exiting = false
  let exitCode = 0

  const session = new TerminalSession({
    id: paneId,
    client: ipc,
    shell: '',
    shellArgs: [],
    cwd: '',
    cols: initial.cols,
    rows: initial.rows,
    seedGrid: {
      cells: initial.cells,
      cursor_x: initial.cursor_x,
      cursor_y: initial.cursor_y,
      cols: initial.cols,
      rows: initial.rows,
      alternate_screen: initial.alternate_screen,
      mouse_protocol: initial.mouse_protocol,
    },
    callbacks: {
      onUpdate: () => schedulePaint(),
      onTitle: title => {
        if (title) process.stdout.write(`\x1b]0;${title}\x07`)
      },
      onExit: code => {
        exiting = true
        exitCode = code
        schedulePaint()
      },
    },
  })

  schedulePaint()

  function schedulePaint() {
    if (paintScheduled) return
    paintScheduled = true
    setImmediate(() => {
      paintScheduled = false
      paint()
      if (exiting) {
        session.detach()
        ipc.close()
        cleanup()
        process.exit(exitCode)
      }
    })
  }

  function paint() {
    const cells = session.cells
    const termCols = process.stdout.columns || 80
    const termRows = process.stdout.rows || 24
    const rowCount = Math.min(cells.length, termRows)
    const out: string[] = [beginFrame()]
    let lastStyle = RESET
    out.push(RESET)
    for (let r = 0; r < rowCount; r++) {
      out.push(`\x1b[${r + 1};1H\x1b[2K`)
      const row = cells[r]!
      const colCount = Math.min(row.length, termCols)
      for (let c = 0; c < colCount; c++) {
        const cell = row[c]!
        const style = cellToAnsi(cell)
        if (style !== lastStyle) {
          out.push(style)
          lastStyle = style
        }
        out.push(cell.ch === '' ? ' ' : cell.ch)
      }
    }
    for (let r = rowCount; r < termRows; r++) {
      out.push(`\x1b[${r + 1};1H\x1b[2K`)
    }
    out.push(RESET)
    const { x: cx, y: cy } = session.cursor
    const cursorSuffix =
      cx >= 0 && cy >= 0 && cx < termCols && cy < termRows
        ? `\x1b[${cy + 1};${cx + 1}H${SHOW_CURSOR}`
        : HIDE_CURSOR
    out.push(endFrame(cursorSuffix))
    process.stdout.write(out.join(''))
  }

  process.stdin.on('data', (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    session.write(s)
  })

  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80
    const r = process.stdout.rows || 24
    session.resize(c, r)
    schedulePaint()
  })

  ipc.on('notification', (ev: unknown) => {
    const { pane_id, body } = ev as { pane_id: string; body: string }
    if (pane_id !== paneId) return
    const cleaned = body.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
    if (!cleaned) return
    const prefix = info.title ? `${info.title}: ` : ''
    process.stdout.write(`\x1b]9;${prefix}${cleaned}\x07`)
  })

  ipc.on('close', () => {
    if (exiting) return
    session.detach()
    cleanup()
    process.exit(1)
  })

  const forcedExit = (code: number) => () => {
    session.detach()
    cleanup()
    process.exit(code)
  }
  process.on('SIGHUP', forcedExit(129))
  process.on('SIGTERM', forcedExit(143))

  await new Promise<void>(() => {})
}

function cellToAnsi(cell: Cell): string {
  const parts = ['0']
  if (cell.bold) parts.push('1')
  if (cell.fg !== undefined) parts.push(colorAnsi(38, cell.fg))
  if (cell.bg !== undefined) parts.push(colorAnsi(48, cell.bg))
  return `\x1b[${parts.join(';')}m`
}

function colorAnsi(base: 38 | 48, value: number): string {
  if (value >= RGB_FLAG) {
    const r = (value >> 16) & 0xff
    const g = (value >> 8) & 0xff
    const b = value & 0xff
    return `${base};2;${r};${g};${b}`
  }
  return `${base};5;${value}`
}
