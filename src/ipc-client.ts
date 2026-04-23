import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import {
  PATHS,
  sendMessage,
  messageDecoder,
  type Cell,
  type ClientMessage,
  type PaneInfo,
  type ServerMessage,
} from './ipc.js'

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type OutgoingMessage = DistOmit<ClientMessage, 'id'>

type PushEvent = Extract<
  ServerMessage,
  { type: 'pane_update' | 'pane_exit' | 'title' | 'notification' | 'bye' }
>

type PendingRequest = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

export type GridPayload = {
  rows: number
  cols: number
  cells: Cell[][]
  cursor_x: number
  cursor_y: number
  alternate_screen?: boolean
  mouse_protocol?: boolean
}

export type StatePayload = {
  version: number
  blob: string | null
  session?: string
}

export type SessionInfo = {
  name: string
  attached: number
  last_active_ms: number
  pane_count: number
  has_state: boolean
}

export class IpcClient extends EventEmitter {
  private sock: Socket | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private attaching = false
  private bufferedEvents: PushEvent[] = []

  connect(socketPath: string = PATHS.socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath)
      let settled = false
      this.sock = sock
      const decoder = messageDecoder<ServerMessage>(
        msg => this.handleMessage(msg),
        err => sock.destroy(err),
      )
      sock.on('data', chunk => {
        decoder(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
      })
      sock.once('connect', () => {
        settled = true
        this.connected = true
        resolve()
      })
      sock.on('error', err => {
        if (!settled) {
          settled = true
          reject(err)
          return
        }
        // Node's EventEmitter throws if 'error' is emitted with no listener, so
        // only forward it when someone is listening; otherwise the socket's
        // 'close' handler below will still run and reject pending requests.
        if (this.listenerCount('error') > 0) this.emit('error', err)
      })
      sock.on('close', () => {
        const wasConnected = this.connected
        this.connected = false
        if (this.sock === sock) this.sock = null
        for (const [, p] of this.pending) p.reject(new Error('socket closed'))
        this.pending.clear()
        if (!settled) {
          settled = true
          reject(new Error('socket closed'))
        }
        if (wasConnected) this.emit('close')
      })
    })
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ack': {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.resolve(msg.data)
        }
        return
      }
      case 'err': {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.reject(new Error(msg.error))
        }
        return
      }
      case 'pane_update':
      case 'pane_exit':
      case 'title':
      case 'notification':
      case 'bye': {
        if (this.attaching && msg.type !== 'bye') {
          this.bufferedEvents.push(msg)
          return
        }
        this.emit(msg.type, msg)
        return
      }
    }
  }

  call<R = unknown>(msg: OutgoingMessage): Promise<R> {
    if (!this.sock || !this.connected) {
      return Promise.reject(new Error('not connected'))
    }
    const id = this.allocateId()
    const full = { ...msg, id } as ClientMessage
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: data => resolve(data as R),
        reject,
      })
      try {
        sendMessage(this.sock!, full)
      } catch (err) {
        // Socket was destroyed between the connected-check and the write.
        // Fail the request now instead of leaving it pending forever.
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private allocateId(): number {
    // Wrap inside u32 (the server also uses 32-bit ids). Skip any id that's
    // still in `pending` so a wraparound can't collide with an in-flight call.
    for (let i = 0; i < 0x1_0000_0000; i++) {
      const id = this.nextId
      this.nextId = this.nextId >= 0x7fff_ffff ? 1 : this.nextId + 1
      if (!this.pending.has(id)) return id
    }
    throw new Error('ipc id space exhausted')
  }

  beginAttach(): void {
    this.attaching = true
    this.bufferedEvents = []
  }

  endAttach(): void {
    this.attaching = false
    const buf = this.bufferedEvents
    this.bufferedEvents = []
    for (const ev of buf) this.emit(ev.type, ev)
  }

  close(): void {
    this.sock?.end()
  }

  hello(version = '0.1') {
    return this.call<{ version: string }>({ type: 'hello', version })
  }

  createPane(args: {
    pane_id: string
    session?: string
    cwd?: string
    shell: string
    args: string[]
    cols: number
    rows: number
    env?: Array<[string, string]>
  }) {
    return this.call({
      type: 'create_pane',
      pane_id: args.pane_id,
      session: args.session,
      cwd: args.cwd,
      shell: args.shell,
      args: args.args,
      cols: args.cols,
      rows: args.rows,
      env: args.env ?? [],
    })
  }

  attachSession(name: string, create = false) {
    return this.call<{ name: string; created: boolean; attached: number }>({
      type: 'attach_session',
      name,
      create,
    })
  }

  listSessions() {
    return this.call<{ sessions: SessionInfo[] }>({ type: 'list_sessions' })
  }

  createSession(name: string) {
    return this.call<{ name: string }>({ type: 'create_session', name })
  }

  killSession(name: string) {
    return this.call<{ killed: string; panes_closed: number }>({
      type: 'kill_session',
      name,
    })
  }

  renameSession(from: string, to: string) {
    return this.call<{ from: string; to: string }>({
      type: 'rename_session',
      from,
      to,
    })
  }

  closePane(pane_id: string) {
    return this.call({ type: 'close_pane', pane_id })
  }

  write(pane_id: string, data: string) {
    return this.call({ type: 'write', pane_id, data })
  }

  resize(pane_id: string, cols: number, rows: number) {
    return this.call({ type: 'resize', pane_id, cols, rows })
  }

  getGrid(pane_id: string) {
    return this.call<GridPayload>({ type: 'get_grid', pane_id })
  }

  getScrollback(pane_id: string, offset: number) {
    return this.call<GridPayload & { offset: number }>({
      type: 'get_scrollback',
      pane_id,
      offset,
    })
  }

  listPanes() {
    return this.call<{ panes: PaneInfo[] }>({ type: 'list_panes' })
  }

  getState(session?: string) {
    return this.call<StatePayload>({ type: 'get_state', session })
  }

  setState(version: number, blob: string, session?: string) {
    return this.call<{ accepted: boolean; version: number }>({
      type: 'set_state',
      session,
      version,
      blob,
    })
  }

  killServer() {
    return this.call({ type: 'kill_server' })
  }

  getScrollbackText(pane_id: string) {
    return this.call<{ lines: string[] }>({
      type: 'get_scrollback_text',
      pane_id,
    })
  }
}
