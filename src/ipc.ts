import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), '.hux')
const BIN_DIR = process.env.HUX_LIBEXEC_DIR || join(ROOT, 'bin')
export const PATHS = {
  dir: ROOT,
  binDir: BIN_DIR,
  socket: join(ROOT, 'server.sock'),
  log: join(ROOT, 'server.log'),
  pid: join(ROOT, 'server.pid'),
}

export type Cell = {
  ch: string
  fg?: number
  bg?: number
  bold?: boolean
}

export type ClientMessage =
  | { type: 'hello'; id: number; version: string }
  | { type: 'attach_session'; id: number; name: string; create?: boolean }
  | { type: 'list_sessions'; id: number }
  | { type: 'create_session'; id: number; name: string }
  | { type: 'kill_session'; id: number; name: string }
  | { type: 'rename_session'; id: number; from: string; to: string }
  | {
      type: 'create_pane'
      id: number
      pane_id: string
      session?: string
      cwd?: string
      shell: string
      args: string[]
      cols: number
      rows: number
      env: Array<[string, string]>
    }
  | { type: 'close_pane'; id: number; pane_id: string }
  | { type: 'write'; id: number; pane_id: string; data: string }
  | { type: 'resize'; id: number; pane_id: string; cols: number; rows: number }
  | { type: 'get_grid'; id: number; pane_id: string }
  | { type: 'get_scrollback'; id: number; pane_id: string; offset: number }
  | { type: 'list_panes'; id: number }
  | { type: 'get_state'; id: number; session?: string }
  | { type: 'set_state'; id: number; session?: string; version: number; blob: string }
  | { type: 'kill_server'; id: number }
  | { type: 'get_scrollback_text'; id: number; pane_id: string }

export type ServerMessage =
  | { type: 'ack'; id: number; data: unknown }
  | { type: 'err'; id: number; error: string }
  | {
      type: 'pane_update'
      pane_id: string
      rows: number
      cols: number
      cells: Cell[][]
      cursor_x: number
      cursor_y: number
      alternate_screen?: boolean
      mouse_protocol?: boolean
    }
  | { type: 'pane_exit'; pane_id: string; exit_code: number }
  | { type: 'title'; pane_id: string; title: string }
  | { type: 'notification'; pane_id: string; body: string }
  | { type: 'bye'; reason: 'exit' | 'busy' | 'kicked' }

export type PaneInfo = {
  id: string
  session: string
  alive: boolean
  exit_code?: number
  title?: string
}

export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export function sendMessage(sock: Socket, msg: unknown): void {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8')
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`ipc frame too large: ${payload.length}`)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  sock.write(Buffer.concat([header, payload]))
}

export function messageDecoder<M>(
  onMessage: (msg: M) => void,
  onError?: (err: Error) => void,
): (chunk: Buffer<ArrayBufferLike>) => void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  return chunk => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const len = buffered.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        buffered = Buffer.alloc(0)
        onError?.(new Error(`ipc frame too large: ${len}`))
        return
      }
      if (buffered.length < 4 + len) break
      const payload = buffered.subarray(4, 4 + len)
      buffered = buffered.subarray(4 + len)
      let parsed: M
      try {
        parsed = JSON.parse(payload.toString('utf8')) as M
      } catch {
        continue
      }
      onMessage(parsed)
    }
  }
}
