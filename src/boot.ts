import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IpcClient } from './ipc-client.js'
import { PATHS } from './ipc.js'

export function ensureRuntimeDir(): void {
  mkdirSync(PATHS.dir, { recursive: true })
  try { chmodSync(PATHS.dir, 0o700) } catch {}
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function serverBinary(): string {
  const envBin = process.env.HUX_SERVER_BIN
  if (envBin && existsSync(envBin)) return envBin

  // Under `bun --compile`, `import.meta.url` lives inside Bun's virtual FS,
  // so we also consult process.execPath and cwd so the binary gets found
  // relative to the real hux on disk.
  const roots = new Set<string>()
  try { roots.add(dirname(fileURLToPath(import.meta.url))) } catch {}
  roots.add(dirname(process.execPath))
  roots.add(process.cwd())

  const relatives = [
    'server/target/release/hux-server',
    'server/target/debug/hux-server',
    '../server/target/release/hux-server',
    '../server/target/debug/hux-server',
  ]
  for (const root of roots) {
    for (const rel of relatives) {
      const p = join(root, rel)
      if (existsSync(p)) return p
    }
  }
  const fallback = join(PATHS.binDir, 'hux-server')
  if (existsSync(fallback)) return fallback
  throw new Error(
    `hux-server binary not found. Build it with:\n  cargo build --release --manifest-path server/Cargo.toml\nor set HUX_SERVER_BIN.`,
  )
}

export async function connectToServer(): Promise<IpcClient> {
  const first = await tryConnect()
  if (first) return first

  const bin = serverBinary()
  const logFd = openSync(PATHS.log, 'a')
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

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (existsSync(PATHS.socket)) {
      const c = await tryConnect()
      if (c) return c
    }
    await sleep(50)
  }
  throw new Error('server did not become reachable within 3s')
}

async function tryConnect(): Promise<IpcClient | null> {
  if (!existsSync(PATHS.socket)) return null
  const c = new IpcClient()
  try {
    await c.connect()
    await c.hello()
    return c
  } catch {
    try { c.close() } catch {}
    return null
  }
}

export async function runKillServer(): Promise<void> {
  if (!existsSync(PATHS.socket)) {
    console.log('no running server')
    return
  }
  const c = new IpcClient()
  try {
    await c.connect()
    await c.hello()
    await c.killServer()
    await new Promise<void>(r => {
      c.once('bye', () => r())
      setTimeout(r, 500)
    })
    c.close()
    console.log('server stopped')
  } catch (e) {
    console.error('kill-server failed:', (e as Error).message)
    process.exit(1)
  }
}
