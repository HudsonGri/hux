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

export type TerminalCaps = {
  // ?2026 DEC synchronized output — wraps a frame so the terminal paints it
  // atomically. Without it we emit HIDE_CURSOR around frames to avoid
  // cursor-race tearing.
  syncUpdate: boolean
  // ?1003 any-event mouse motion — reports on every cell the cursor crosses.
  // Without it we fall back to ?1002 (button-event only) so hover flood
  // doesn't swamp stdin on basic terminals.
  anyMotionMouse: boolean
  // OSC 22 cursor shape — Ghostty/kitty/WezTerm/iTerm2 honor it; Terminal.app
  // ignores and pollutes output instead.
  pointerShape: boolean
}

// Env-based detection is the seed; the runtime probe (see terminal-probe.ts)
// updates these after startup based on the actual terminal's DECRQM responses.
// Over SSH, env hints are usually wrong (remote sees TERM=xterm-256color) but
// the probe reaches through to the user's real terminal.
export const terminalCaps: TerminalCaps = {
  syncUpdate: isRichTerminal,
  anyMotionMouse: isRichTerminal,
  pointerShape: isRichTerminal,
}

export function updateCaps(patch: Partial<TerminalCaps>): void {
  Object.assign(terminalCaps, patch)
}
