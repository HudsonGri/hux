function normEnv(name: string): string {
  return (process.env[name] ?? '').toLowerCase()
}

function detectRichTerminal(): boolean {
  if (process.env.HUX_BASIC_TERMINAL === '1') return false
  if (process.env.HUX_RICH_TERMINAL === '1') return true
  if (process.env.KITTY_WINDOW_ID) return true
  const tp = normEnv('TERM_PROGRAM')
  if (
    tp.includes('ghostty') ||
    tp.includes('kitty') ||
    tp.includes('wezterm') ||
    tp.includes('iterm')
  ) {
    return true
  }
  const term = normEnv('TERM')
  if (term.includes('kitty')) return true
  return false
}

export const isRichTerminal = detectRichTerminal()

// OSC 22 (cursor shape): Ghostty/kitty/WezTerm/iTerm2 support it; Terminal.app
// does not, and the sequence fires on every hover event — silence it there.
export const pointerShapeSupported = isRichTerminal

// ?1003h (any-event motion) reports on every cell the cursor crosses. Pairing
// that with a full-frame repaint on terminals without synchronous update
// (Terminal.app) produces visible tearing and input lag. Fall back to ?1002h
// (button-event motion) so hover cells don't flood stdin.
export const anyMotionMouseSupported = isRichTerminal

// ?2026h/l wraps a frame so the terminal paints it atomically. Unsupported
// terminals ignore the DEC private mode silently, but we still gate on it to
// avoid emitting a few unused bytes per frame.
export const syncUpdateSupported = isRichTerminal
