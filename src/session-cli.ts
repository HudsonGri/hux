import { existsSync } from 'node:fs'
import { IpcClient, type SessionInfo } from './ipc-client.js'
import { PATHS } from './ipc.js'

async function withClient<T>(fn: (ipc: IpcClient) => Promise<T>): Promise<T> {
  if (!existsSync(PATHS.socket)) {
    throw new Error('no running hux server')
  }
  const ipc = new IpcClient()
  await ipc.connect()
  await ipc.hello()
  try {
    return await fn(ipc)
  } finally {
    ipc.close()
  }
}

function formatRelative(lastMs: number): string {
  if (!lastMs) return '—'
  const delta = Date.now() - lastMs
  if (delta < 0) return 'now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export async function runListSessions(): Promise<void> {
  const { sessions } = await withClient(ipc => ipc.listSessions())
  if (sessions.length === 0) {
    process.stdout.write('(no sessions)\n')
    return
  }
  const rows: Array<[string, string, string, string, string]> = [
    ['SESSION', 'PANES', 'CLIENTS', 'STATE', 'ACTIVE'],
  ]
  for (const s of sessions) {
    rows.push([
      s.name,
      String(s.pane_count),
      String(s.attached),
      s.has_state ? 'saved' : 'empty',
      formatRelative(s.last_active_ms),
    ])
  }
  const widths = rows[0]!.map((_, col) =>
    rows.reduce((w, row) => Math.max(w, row[col]!.length), 0),
  )
  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ')
    process.stdout.write(`${line.trimEnd()}\n`)
  }
}

export async function runKillSession(name: string): Promise<void> {
  const res = await withClient(ipc => ipc.killSession(name))
  process.stdout.write(
    `killed session "${res.killed}" (${res.panes_closed} pane${
      res.panes_closed === 1 ? '' : 's'
    })\n`,
  )
}

export async function runRenameSession(from: string, to: string): Promise<void> {
  const res = await withClient(ipc => ipc.renameSession(from, to))
  process.stdout.write(`renamed "${res.from}" → "${res.to}"\n`)
}

export type { SessionInfo }
