import {
  anyMotionMouseSupported,
  pointerShapeSupported,
  syncUpdateSupported,
} from './terminal-caps.js'

export const ENTER_ALT_SCREEN = '\x1b[?1049h'
export const EXIT_ALT_SCREEN = '\x1b[?1049l'
export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
export const HOME = '\x1b[H'
export const CLEAR_SCREEN = '\x1b[2J'

// ?1003 = any-event motion (hover cells included); ?1002 = button-event motion
// only. Rich terminals render fast enough to handle the hover flood; basic
// terminals fall back and lose hover cursor hints but stay responsive.
const MOTION_MODE = anyMotionMouseSupported ? '?1003' : '?1002'
export const ENABLE_MOUSE = `\x1b[?1000h\x1b[${MOTION_MODE}h\x1b[?1006h`
export const DISABLE_MOUSE = `\x1b[?1006l\x1b[${MOTION_MODE}l\x1b[?1000l`

export const RESET_POINTER = pointerShapeSupported ? '\x1b]22;\x1b\\' : ''

export const BEGIN_SYNC_UPDATE = syncUpdateSupported ? '\x1b[?2026h' : ''
export const END_SYNC_UPDATE = syncUpdateSupported ? '\x1b[?2026l' : ''

export const RESET = '\x1b[0m'
