import type { CellStyle, PaintFn } from './runtime.js'
import type { Cell } from './ipc.js'
import type { IpcClient } from './ipc-client.js'

const MIN_COLS = 4
const MIN_ROWS = 2

export type TerminalCallbacks = {
  onTitle?: (title: string) => void
  onExit?: (code: number, signal?: number) => void
  onUpdate: () => void
}

export type RemoteSessionParams = {
  id: string
  shell: string
  shellArgs: string[]
  cwd: string
  cols: number
  rows: number
  client: IpcClient
  callbacks: TerminalCallbacks
  env?: Array<[string, string]>
  session?: string
  seedGrid?: {
    cells: Cell[][]
    cursor_x: number
    cursor_y: number
    rows: number
    cols: number
    alternate_screen?: boolean
    mouse_protocol?: boolean
  }
}

export class RemoteSession {
  readonly id: string
  private client: IpcClient
  private callbacks: TerminalCallbacks
  private cols: number
  private rows: number
  private grid: Cell[][] = []
  private cursorX = 0
  private cursorY = 0
  private altScreen = false
  private mouseProtocol = false
  private disposed = false
  private createPromise: Promise<unknown> | null = null
  private lastTitle = ''

  private readonly onPaneUpdate = (ev: unknown) => {
    const msg = ev as {
      pane_id: string
      rows: number
      cols: number
      cells: Cell[][]
      cursor_x: number
      cursor_y: number
      alternate_screen?: boolean
      mouse_protocol?: boolean
    }
    if (msg.pane_id !== this.id || this.disposed) return
    this.grid = msg.cells
    this.cursorX = msg.cursor_x
    this.cursorY = msg.cursor_y
    this.cols = msg.cols
    this.rows = msg.rows
    this.altScreen = !!msg.alternate_screen
    this.mouseProtocol = !!msg.mouse_protocol
    this.callbacks.onUpdate()
  }

  private readonly onPaneExit = (ev: unknown) => {
    const msg = ev as { pane_id: string; exit_code: number }
    if (msg.pane_id !== this.id || this.disposed) return
    this.callbacks.onExit?.(msg.exit_code)
  }

  private readonly onTitle = (ev: unknown) => {
    const msg = ev as { pane_id: string; title: string }
    if (msg.pane_id !== this.id || this.disposed) return
    if (msg.title === this.lastTitle) return
    this.lastTitle = msg.title
    this.callbacks.onTitle?.(msg.title)
  }

  constructor(params: RemoteSessionParams) {
    this.id = params.id
    this.client = params.client
    this.callbacks = params.callbacks
    this.cols = Math.max(params.cols, MIN_COLS)
    this.rows = Math.max(params.rows, MIN_ROWS)

    this.client.on('pane_update', this.onPaneUpdate)
    this.client.on('pane_exit', this.onPaneExit)
    this.client.on('title', this.onTitle)

    if (params.seedGrid) {
      this.grid = params.seedGrid.cells
      this.cursorX = params.seedGrid.cursor_x
      this.cursorY = params.seedGrid.cursor_y
      this.cols = params.seedGrid.cols
      this.rows = params.seedGrid.rows
      this.altScreen = !!params.seedGrid.alternate_screen
      this.mouseProtocol = !!params.seedGrid.mouse_protocol
    } else {
      this.createPromise = this.client
        .createPane({
          pane_id: this.id,
          session: params.session,
          cwd: params.cwd,
          shell: params.shell,
          args: params.shellArgs,
          cols: this.cols,
          rows: this.rows,
          env: params.env,
        })
        .catch(err => {
          if (!this.disposed) this.callbacks.onExit?.(-1)
        })
    }
  }

  write(data: string): void {
    if (this.disposed) return
    const send = () => {
      if (this.disposed) return
      this.client.write(this.id, data).catch(() => {})
    }
    if (this.createPromise) {
      this.createPromise.then(send, () => {})
    } else {
      send()
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    const nextCols = Math.max(cols, MIN_COLS)
    const nextRows = Math.max(rows, MIN_ROWS)
    if (nextCols === this.cols && nextRows === this.rows) return
    this.cols = nextCols
    this.rows = nextRows
    const send = () => {
      if (this.disposed) return
      this.client.resize(this.id, nextCols, nextRows).catch(() => {})
    }
    if (this.createPromise) {
      this.createPromise.then(send, () => {})
    } else {
      send()
    }
  }

  kill(_signal?: string): void {
    if (this.disposed) return
    this.client.closePane(this.id).catch(() => {})
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.client.off('pane_update', this.onPaneUpdate)
    this.client.off('pane_exit', this.onPaneExit)
    this.client.off('title', this.onTitle)
    this.client.closePane(this.id).catch(() => {})
  }

  detach(): void {
    if (this.disposed) return
    this.disposed = true
    this.client.off('pane_update', this.onPaneUpdate)
    this.client.off('pane_exit', this.onPaneExit)
    this.client.off('title', this.onTitle)
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  get cursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY }
  }

  get cells(): readonly (readonly Cell[])[] {
    return this.grid
  }

  get usesAltScreen(): boolean {
    return this.altScreen
  }

  get usesMouseProtocol(): boolean {
    return this.mouseProtocol
  }

  paintInto: PaintFn = (painter, rect) => {
    this.paintCells(painter, rect)
  }

  paintWithCursorMarker: PaintFn = (painter, rect) => {
    this.paintCells(painter, rect)
    const cx = this.cursorX
    const cy = this.cursorY
    if (cx >= 0 && cx < rect.width && cy >= 0 && cy < rect.height) {
      const row = this.grid[cy]
      const cell = row ? row[cx] : undefined
      const ch = cell && cell.ch !== '' ? cell.ch : ' '
      const base = cell ? cellToStyle(cell) : {}
      painter.set(rect.x + cx, rect.y + cy, ch, {
        ...base,
        fg: base.bg ?? 234,
        bg: base.fg ?? 244,
      })
    }
  }

  private paintCells(
    painter: { set: (x: number, y: number, char: string, style?: CellStyle) => void },
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const baseX = rect.x
    const baseY = rect.y
    const rowCount = Math.min(this.grid.length, rect.height)
    for (let r = 0; r < rowCount; r++) {
      const row = this.grid[r]
      if (!row) continue
      const colCount = Math.min(row.length, rect.width)
      for (let c = 0; c < colCount; c++) {
        const cell = row[c]
        if (!cell) continue
        const ch = cell.ch === '' ? ' ' : cell.ch
        painter.set(baseX + c, baseY + r, ch, cellToStyle(cell))
      }
    }
  }
}

function cellToStyle(cell: Cell): CellStyle {
  const style: CellStyle = {}
  if (cell.fg !== undefined) style.fg = cell.fg
  if (cell.bg !== undefined) style.bg = cell.bg
  if (cell.bold) style.bold = true
  return style
}

export { RemoteSession as TerminalSession }
