import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, type Socket } from 'node:net'
import type { Cell } from './ipc.js'
import { PATHS } from './ipc.js'

export type DragStartPayload = {
  paneId: string
  title: string
  accent: number
  preview: Cell[][]
  sourcePid: number
  huxBinary: string
  command?: string
}

export type DragResultEvent =
  | { op: 'drag_result'; outcome: 'dropped'; target: 'new_tab' | 'input_text' | 'new_window' }
  | { op: 'drag_result'; outcome: 'cancelled' }
  | { op: 'drag_result'; outcome: 'error'; message: string }
  | { op: 'permission_denied'; what: string }
  | { op: 'hello'; version: string }
  | { op: 'pong' }

export type DragBridgeEvent = DragResultEvent

const DRAG_BRIDGE_MAX_FRAME_BYTES = 1 << 20 // 1 MiB

export class DragBridge extends EventEmitter {
  private sock: Socket | null = null
  private connecting: Promise<void> | null = null
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private spawned = false

  async ensureConnected(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = this.bootstrap().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async bootstrap(): Promise<void> {
    const sockPath = socketPath()
    if (!existsSync(sockPath) && !this.spawned) {
      await this.spawnDaemon()
    }
    for (let i = 0; i < 40 && !existsSync(sockPath); i++) {
      await sleep(25)
    }
    if (!existsSync(sockPath)) {
      throw new Error('hux-drag-daemon socket never appeared')
    }
    await this.connectTo(sockPath)
  }

  private async connectTo(sockPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = connect(sockPath)
      const onErr = (e: Error) => {
        s.off('connect', onOk)
        reject(e)
      }
      const onOk = () => {
        s.off('error', onErr)
        resolve()
      }
      s.once('error', onErr)
      s.once('connect', onOk)
      this.sock = s
    })
    this.sock!.on('data', chunk => {
      this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    })
    this.sock!.on('close', () => {
      this.sock = null
      this.buf = Buffer.alloc(0)
      this.emit('disconnected')
    })
    this.sock!.on('error', () => {
      try { this.sock?.destroy() } catch {}
      this.sock = null
    })
  }

  private async spawnDaemon(): Promise<void> {
    const bin = daemonBinary()
    if (!bin) {
      throw new Error('hux-drag-daemon binary not found. build it with: swift build -c release --package-path daemon')
    }
    this.spawned = true
    const logFd = openSync(daemonLogPath(), 'a')
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      })
    } finally {
      closeSync(logFd)
    }
    child.unref()
  }

  private onData(chunk: Buffer<ArrayBufferLike>): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    while (true) {
      const nl = this.buf.indexOf(0x0a)
      if (nl < 0) {
        if (this.buf.length > DRAG_BRIDGE_MAX_FRAME_BYTES) {
          // A well-formed message from the daemon is well under 1 KiB. If we've
          // buffered more than a megabyte without seeing a newline, the stream
          // is corrupt (or hostile) — drop the connection instead of growing
          // the buffer.
          try { this.sock?.destroy(new Error('drag bridge frame too large')) } catch {}
          this.sock = null
          this.buf = Buffer.alloc(0)
        }
        return
      }
      const line = this.buf.subarray(0, nl)
      this.buf = this.buf.subarray(nl + 1)
      if (line.length === 0) continue
      let parsed: DragResultEvent
      try {
        parsed = JSON.parse(line.toString('utf8')) as DragResultEvent
      } catch {
        continue
      }
      this.emit('message', parsed)
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.sock || this.sock.destroyed) return
    const data = JSON.stringify(obj) + '\n'
    this.sock.write(data)
  }

  async startDrag(payload: DragStartPayload): Promise<void> {
    await this.ensureConnected()
    const msg: Record<string, unknown> = {
      op: 'drag_start',
      pane_id: payload.paneId,
      title: payload.title,
      accent: payload.accent,
      preview: payload.preview,
      source_pid: payload.sourcePid,
      hux_binary: payload.huxBinary,
    }
    if (payload.command) msg.command = payload.command
    this.send(msg)
  }

  cancel(): void {
    if (!this.sock || this.sock.destroyed) return
    this.send({ op: 'drag_cancel' })
  }

  close(): void {
    try { this.sock?.end() } catch {}
    this.sock = null
    this.buf = Buffer.alloc(0)
  }
}

export function samplePreview(cells: readonly (readonly Cell[])[], cols = 30, rows = 8): Cell[][] {
  const out: Cell[][] = []
  const rowLimit = Math.min(cells.length, rows)
  for (let r = 0; r < rowLimit; r++) {
    const row = cells[r]!
    const colLimit = Math.min(row.length, cols)
    const outRow: Cell[] = []
    for (let c = 0; c < colLimit; c++) {
      const cell = row[c]
      if (!cell) {
        outRow.push({ ch: ' ' })
        continue
      }
      outRow.push({
        ch: cell.ch === '' ? ' ' : cell.ch,
        fg: cell.fg,
        bg: cell.bg,
        bold: cell.bold,
      })
    }
    out.push(outRow)
  }
  return out
}

function socketPath(): string {
  const override = process.env.HUX_DRAG_SOCKET
  if (override) return override
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), '.local/state')
  const dir = join(xdg, 'hux')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return join(dir, 'drag.sock')
}

function daemonLogPath(): string {
  return join(PATHS.dir, 'drag-daemon.log')
}

function daemonBinary(): string | null {
  const envBin = process.env.HUX_DRAG_DAEMON_BIN
  if (envBin && existsSync(envBin)) return envBin

  // When running as a `bun --compile`d binary, `import.meta.url` points into
  // Bun's virtual FS, so we can't find the daemon relative to it. Use the
  // real binary path (process.execPath) and the cwd as extra roots.
  const roots = new Set<string>()
  try { roots.add(dirname(fileURLToPath(import.meta.url))) } catch {}
  roots.add(dirname(process.execPath))
  roots.add(process.cwd())

  const relatives = [
    'daemon/.build/release/hux-drag-daemon',
    'daemon/.build/arm64-apple-macosx/release/hux-drag-daemon',
    '../daemon/.build/release/hux-drag-daemon',
    '../daemon/.build/arm64-apple-macosx/release/hux-drag-daemon',
  ]
  for (const root of roots) {
    for (const rel of relatives) {
      const p = join(root, rel)
      if (existsSync(p)) return p
    }
  }
  const fallback = join(PATHS.binDir, 'hux-drag-daemon')
  if (existsSync(fallback)) return fallback
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
