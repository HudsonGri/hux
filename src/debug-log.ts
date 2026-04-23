import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from './ipc.js'

const DEBUG_LOG_PATH = join(PATHS.dir, 'peek-debug.log')
const debugStartedAt = Date.now()
const debugLogging = process.env.HUX_DEBUG_PEEK === '1'

export function debugLogInput(chunk: string): void {
  if (!debugLogging) return
  if (Date.now() - debugStartedAt > 3000) return
  try {
    const safe = chunk
      .replace(/\x1b/g, '\\e')
      .replace(/[\x00-\x1f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    appendFileSync(
      DEBUG_LOG_PATH,
      `${new Date().toISOString()} input: ${safe}\n`,
    )
  } catch {}
}

export function debugLogLine(line: string): void {
  if (!debugLogging) return
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
