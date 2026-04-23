import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { IpcClient } from './ipc-client.js'
import { PATHS } from './ipc.js'
import { VERSION } from './version.js'

const REPO = 'HudsonGri/hux'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const LAST_CHECK_FILE = join(PATHS.dir, 'last-update-check')
const AVAILABLE_FILE = join(PATHS.dir, 'update-available')

type ReleaseInfo = {
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}

function archSlug(): string | null {
  const p = platform()
  const a = arch()
  if (p === 'darwin') {
    if (a === 'arm64') return 'darwin-arm64'
    if (a === 'x64') return 'darwin-x86_64'
  }
  if (p === 'linux') {
    if (a === 'x64') return 'linux-x86_64'
    if (a === 'arm64') return 'linux-aarch64'
  }
  return null
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

async function fetchLatest(signal?: AbortSignal): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: {
        'User-Agent': `hux-updater/${VERSION}`,
        Accept: 'application/vnd.github+json',
      },
      signal,
    })
    if (!res.ok) return null
    return (await res.json()) as ReleaseInfo
  } catch {
    return null
  }
}

async function verifyChecksum(file: string, checksumUrl: string): Promise<void> {
  const res = await fetch(checksumUrl, {
    headers: { 'User-Agent': `hux-updater/${VERSION}` },
  })
  if (!res.ok) {
    throw new Error(`checksum download failed (${res.status})`)
  }
  const text = await res.text()
  const expected = text.trim().split(/\s+/)[0]?.toLowerCase()
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('checksum file is malformed')
  }
  const actual = await sha256File(file)
  if (actual !== expected) {
    throw new Error(`checksum mismatch (expected ${expected}, got ${actual})`)
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export function startupUpdateCheck(): void {
  if (VERSION === 'dev') return
  if (!archSlug()) return

  let last = 0
  try { last = parseInt(readFileSync(LAST_CHECK_FILE, 'utf8'), 10) || 0 } catch {}
  if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return

  void (async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 5000)
    const rel = await fetchLatest(ctl.signal)
    clearTimeout(timer)
    try { mkdirSync(PATHS.dir, { recursive: true }) } catch {}
    try { writeFileSync(LAST_CHECK_FILE, String(Date.now())) } catch {}
    if (!rel) return
    if (compareVersions(rel.tag_name, VERSION) > 0) {
      try { writeFileSync(AVAILABLE_FILE, rel.tag_name) } catch {}
    } else {
      try { unlinkSync(AVAILABLE_FILE) } catch {}
    }
  })()
}

export function pendingUpdateNotice(): string | null {
  if (VERSION === 'dev') return null
  try {
    const available = readFileSync(AVAILABLE_FILE, 'utf8').trim()
    if (available && compareVersions(available, VERSION) > 0) {
      return `hux ${available} available (you have ${VERSION}) — run 'hux update' to upgrade`
    }
  } catch {}
  return null
}

async function stopServer(): Promise<void> {
  if (!existsSync(PATHS.socket)) return
  try {
    const c = new IpcClient()
    await c.connect()
    await c.hello()
    await c.killServer()
    await new Promise<void>(resolve => {
      c.once('bye', () => resolve())
      setTimeout(resolve, 500)
    })
    c.close()
  } catch {}
}

export async function runUpdate(): Promise<void> {
  if (VERSION === 'dev') {
    process.stderr.write("hux: update unavailable in dev builds. build locally with 'bun run build'.\n")
    process.exit(1)
  }
  const slug = archSlug()
  if (!slug) {
    process.stderr.write(`hux: update only supported on macOS (detected ${platform()}/${arch()}).\n`)
    process.exit(1)
  }

  process.stdout.write('checking for updates...\n')
  const rel = await fetchLatest()
  if (!rel) {
    process.stderr.write('hux: could not reach github. check your connection.\n')
    process.exit(1)
  }
  const cmp = compareVersions(rel.tag_name, VERSION)
  if (cmp <= 0) {
    process.stdout.write(`hux ${VERSION} is up to date.\n`)
    try { unlinkSync(AVAILABLE_FILE) } catch {}
    return
  }

  const assetName = `hux-${slug}.tar.gz`
  const asset = rel.assets.find(a => a.name === assetName)
  if (!asset) {
    process.stderr.write(`hux: release ${rel.tag_name} has no asset named ${assetName}.\n`)
    process.exit(1)
  }

  process.stdout.write(`downloading ${rel.tag_name} (${slug})...\n`)
  const tmp = join(tmpdir(), `hux-update-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const tgz = join(tmp, 'hux.tar.gz')

  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': `hux-updater/${VERSION}` },
  })
  if (!res.ok || !res.body) {
    process.stderr.write(`hux: download failed (${res.status}).\n`)
    process.exit(1)
  }
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tgz))
  try {
    await verifyChecksum(tgz, `${asset.browser_download_url}.sha256`)
  } catch (err) {
    process.stderr.write(`hux: ${(err as Error).message}.\n`)
    process.exit(1)
  }

  const extract = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' })
  if (extract.status !== 0) {
    process.stderr.write('hux: tar extraction failed.\n')
    process.exit(1)
  }

  const newClient = join(tmp, 'hux')
  const newServer = join(tmp, 'hux-server')
  const newDaemon = join(tmp, 'hux-drag-daemon')
  if (!existsSync(newClient)) {
    process.stderr.write('hux: tarball missing client binary.\n')
    process.exit(1)
  }

  spawnSync('xattr', ['-dr', 'com.apple.quarantine', tmp])

  await stopServer()
  spawnSync('pkill', ['-x', 'hux-drag-daemon'])

  const binDir = PATHS.binDir
  mkdirSync(binDir, { recursive: true })

  chmodSync(newClient, 0o755)
  if (existsSync(newServer)) {
    chmodSync(newServer, 0o755)
    renameSync(newServer, join(binDir, 'hux-server'))
  }
  if (existsSync(newDaemon)) {
    chmodSync(newDaemon, 0o755)
    renameSync(newDaemon, join(binDir, 'hux-drag-daemon'))
  }

  // macOS lets you rename() over a running executable — the kernel keeps the
  // inode alive until the process exits.
  renameSync(newClient, process.execPath)

  try { unlinkSync(AVAILABLE_FILE) } catch {}
  process.stdout.write(`hux updated to ${rel.tag_name}.\n`)
}
