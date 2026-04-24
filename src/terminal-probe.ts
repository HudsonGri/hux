import { updateCaps } from './terminal-caps.js'

// DECRQM response: CSI ? <code> ; <status> $ y
//   status 0 = unrecognized, 1 = set, 2 = reset, 3 = permanently set,
//   4 = permanently reset. Any non-zero means the terminal recognizes the mode.
const DECRPM_RE = /\x1b\[\?(\d+);(\d)\$y/g

const PROBE_QUERIES = {
  // ?2026 DEC synchronized output (BatchedDraw).
  syncUpdate: '\x1b[?2026$p',
  // ?1003 any-event mouse motion reporting.
  anyMotionMouse: '\x1b[?1003$p',
} as const

let probed = false

export async function probeTerminalCaps(timeoutMs = 120): Promise<void> {
  if (probed) return
  probed = true

  if (!process.stdin.isTTY || !process.stdout.isTTY) return
  if (typeof process.stdin.setRawMode !== 'function') return

  // Temporarily intercept stdin to capture probe responses. Caller is expected
  // to have put stdin in raw mode already so byte-level replies come through
  // without line buffering.
  const captured: string[] = []
  const onData = (chunk: Buffer | string) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }

  const prevEncoding = process.stdin.readableEncoding
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onData)
  const wasPaused = process.stdin.isPaused()
  if (wasPaused) process.stdin.resume()

  process.stdout.write(PROBE_QUERIES.syncUpdate + PROBE_QUERIES.anyMotionMouse)

  await new Promise<void>(resolve => setTimeout(resolve, timeoutMs))

  process.stdin.off('data', onData)
  if (wasPaused) process.stdin.pause()
  if (prevEncoding) process.stdin.setEncoding(prevEncoding)

  const joined = captured.join('')
  const patch: Parameters<typeof updateCaps>[0] = {}
  for (const match of joined.matchAll(DECRPM_RE)) {
    const code = Number(match[1])
    const status = Number(match[2])
    const supported = status >= 1 && status <= 4
    if (code === 2026) patch.syncUpdate = supported
    else if (code === 1003) patch.anyMotionMouse = supported
  }

  if (Object.keys(patch).length > 0) updateCaps(patch)
}
