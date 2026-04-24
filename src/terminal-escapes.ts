import { terminalCaps } from './terminal-caps.js'

export const ENTER_ALT_SCREEN = '\x1b[?1049h'
export const EXIT_ALT_SCREEN = '\x1b[?1049l'
export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
export const HOME = '\x1b[H'
export const CLEAR_SCREEN = '\x1b[2J'
export const RESET = '\x1b[0m'

// ?1003 = any-event motion (hover cells included); ?1002 = button-event motion
// only. Rich terminals render fast enough to handle the hover flood; basic
// terminals fall back and lose hover cursor hints but stay responsive.
export function enableMouse(): string {
  const mode = terminalCaps.anyMotionMouse ? '?1003' : '?1002'
  return `\x1b[?1000h\x1b[${mode}h\x1b[?1006h`
}

export function disableMouse(): string {
  const mode = terminalCaps.anyMotionMouse ? '?1003' : '?1002'
  return `\x1b[?1006l\x1b[${mode}l\x1b[?1000l`
}

export function resetPointer(): string {
  return terminalCaps.pointerShape ? '\x1b]22;\x1b\\' : ''
}

// ?2026h/l wraps a frame so the terminal paints it atomically. Unsupported
// terminals ignore the DEC private mode silently, but we still gate on it to
// avoid emitting a few unused bytes per frame.
export function beginSyncUpdate(): string {
  return terminalCaps.syncUpdate ? '\x1b[?2026h' : ''
}

export function endSyncUpdate(): string {
  return terminalCaps.syncUpdate ? '\x1b[?2026l' : ''
}
