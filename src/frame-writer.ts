import {
  HIDE_CURSOR,
  HOME,
  beginSyncUpdate,
  endSyncUpdate,
} from './terminal-escapes.js'

// Every frame starts by hiding the cursor and homing. When the terminal
// supports DEC synchronized output (?2026), we additionally bracket the whole
// frame so painting is atomic. When it doesn't (common over SSH to an
// xterm-256color remote), hiding the cursor is still enough to stop the
// cursor-race tearing you'd otherwise see as each row repaints in turn.
export function beginFrame(): string {
  return beginSyncUpdate() + HIDE_CURSOR + HOME
}

// cursorSuffix is the caller-computed final cursor state — either HIDE_CURSOR
// (if nothing should show) or a position + SHOW_CURSOR sequence. It's emitted
// inside the sync-update bracket so the final paint is indivisible from the
// frame body.
export function endFrame(cursorSuffix: string): string {
  return cursorSuffix + endSyncUpdate()
}
