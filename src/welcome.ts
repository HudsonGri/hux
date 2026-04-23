import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from './ipc.js'
import { VERSION } from './version.js'

const WELCOMED_FILE = join(PATHS.dir, 'welcomed')

// Animation timing. One motion law for every star: full-speed warp for
// WARP_FULL frames, then smootherstep-decelerate to a halt over DECEL frames.
// Text stars are just warp stars whose angle + starting distance are chosen
// so that their pure radial trajectory lands exactly on their bitmap pixel
// at FREEZE_FRAME. No bending, no separate "transition" phase — the wordmark
// is what you see when motion stops and the bg has faded out.
const FPS = 24
const FRAME_MS = Math.round(1000 / FPS)
const WARP_FULL = 24         // frames of full-speed warp
const DECEL = 24             // frames decelerating from full speed to stopped
const FREEZE_FRAME = WARP_FULL + DECEL  // all motion stops; text stars on target
const SETTLE_END = FREEZE_FRAME

// Bg fade is coupled to the deceleration: bg brightness follows motion — the
// less stars are moving, the less the warp exists. Done just before freeze so
// the wordmark isn't competing with leftover streaks.
const BG_FADE_START = WARP_FULL
const BG_FADE_END = FREEZE_FRAME - 2

// Luminance ramp — density-ordered. Empty cell at index 0 so brightness 0
// renders as blank.
const LUMINANCE = ' .,:-=+*#%@'
const RAMP_COLORS: readonly string[] = [
  '',
  '\x1b[38;5;17m',
  '\x1b[38;5;18m',
  '\x1b[38;5;24m',
  '\x1b[38;5;31m',
  '\x1b[38;5;38m',
  '\x1b[38;5;44m',
  '\x1b[38;5;51m',
  '\x1b[38;5;87m',
  '\x1b[38;5;159m',
  '\x1b[38;5;195m',
]
const RESET = '\x1b[0m'
const DIM = '\x1b[38;5;240m'
const MUTED = '\x1b[38;5;245m'
const ACCENT = '\x1b[38;5;117m'

const ASPECT_Y = 0.5 // terminal cells are ~2× taller than wide

// Lowercase hux bitmaps, 7 cols × 9 rows. Ascender in h occupies the first
// three rows; u and x share the x-height body, aligned on a common baseline.
const BITMAPS: Record<string, readonly string[]> = {
  h: [
    '##.....',
    '##.....',
    '##.....',
    '##.###.',
    '#######',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
  ],
  u: [
    '.......',
    '.......',
    '.......',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '.#####.',
  ],
  x: [
    '.......',
    '.......',
    '.......',
    '##...##',
    '.##.##.',
    '..###..',
    '..###..',
    '.##.##.',
    '##...##',
  ],
}

const WORDMARK = 'hux'
const CHAR_W = 7
const CHAR_H = 9
const CHAR_GAP = 1
const TAIL_FRAMES = 5

type Vec2 = { x: number; y: number }

type Star = {
  angle: number
  initialDist: number
  speed: number
  brightness: number
  target: Vec2 | null
}

export function needsWelcome(): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  if (process.env.HUX_SKIP_WELCOME === '1') return false
  return !existsSync(WELCOMED_FILE)
}

function markWelcomed(): void {
  try {
    writeFileSync(WELCOMED_FILE, `${VERSION}\n${new Date().toISOString()}\n`)
  } catch {}
}

export async function showWelcome(): Promise<void> {
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24

  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H')

  const stopRef = { stopped: false }
  const keyPress = waitForKey().then(v => {
    stopRef.stopped = true
    return v
  })

  const textWidth = WORDMARK.length * CHAR_W + (WORDMARK.length - 1) * CHAR_GAP
  if (cols < textWidth + 6 || rows < CHAR_H + 4) {
    renderMinimal(cols, rows)
  } else {
    await playAnimation(cols, rows, stopRef)
  }

  const cont = await keyPress
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  markWelcomed()
  if (!cont) process.exit(0)
}

// --- seeded RNG ------------------------------------------------------------

let rngSeed = 0x13371337
function srand(): number {
  rngSeed = (rngSeed * 1664525 + 1013904223) | 0
  return (rngSeed >>> 0) / 4294967295
}

// --- star init -------------------------------------------------------------

function wordmarkPositions(canvasW: number, canvasH: number): Vec2[] {
  const textW = WORDMARK.length * CHAR_W + (WORDMARK.length - 1) * CHAR_GAP
  const startX = Math.floor((canvasW - textW) / 2)
  const startY = Math.floor((canvasH - CHAR_H) / 2)
  const out: Vec2[] = []
  for (let i = 0; i < WORDMARK.length; i++) {
    const ch = WORDMARK[i]!
    const bmp = BITMAPS[ch]
    if (!bmp) continue
    const letterX = startX + i * (CHAR_W + CHAR_GAP)
    for (let r = 0; r < CHAR_H; r++) {
      const row = bmp[r]!
      for (let c = 0; c < CHAR_W; c++) {
        if (row[c] === '#') out.push({ x: letterX + c, y: startY + r })
      }
    }
  }
  return out
}

function initStars(canvasW: number, canvasH: number): Star[] {
  rngSeed = 0x13371337
  const stars: Star[] = []

  // Roughly one background star per ~15 cells of canvas, clamped to a sane
  // range so tiny and huge terminals both render reasonable densities.
  const bgCount = Math.max(140, Math.min(900, Math.round((canvasW * canvasH) / 15)))

  for (let i = 0; i < bgCount; i++) {
    stars.push({
      angle: srand() * Math.PI * 2,
      initialDist: 0.5 + srand() * 22,
      speed: 0.22 + srand() * 0.5,
      // Wider brightness spread so the warp uses the full palette — dim
      // stars land in the deep navy bins, bright ones in the cyan/white bins.
      brightness: 0.15 + srand() * 0.85,
      target: null,
    })
  }

  // Text stars: angle and initial distance are derived from the target, so
  // that dist(FREEZE_FRAME) == targetDist and project() lands exactly on the
  // bitmap pixel. They behave as warp stars throughout — same motion law as
  // bg — until freeze, at which point they're simply at rest on the wordmark.
  const cx = (canvasW - 1) / 2
  const cy = (canvasH - 1) / 2
  const fov = Math.min(canvasW, canvasH / ASPECT_Y) * 0.38
  const totalTravel = distTraveled(FREEZE_FRAME)

  for (const pos of wordmarkPositions(canvasW, canvasH)) {
    const dx = pos.x - cx
    const dy = (pos.y - cy) / ASPECT_Y
    const r = Math.max(0.5, Math.sqrt(dx * dx + dy * dy))
    const angle = Math.atan2(dy, dx)
    const targetDist = fov / r

    const speed = 0.22 + srand() * 0.3
    const initialDist = targetDist + speed * totalTravel

    stars.push({
      angle,
      initialDist,
      speed,
      brightness: 0.82 + srand() * 0.14,
      target: pos,
    })
  }

  return stars
}

// --- math helpers ----------------------------------------------------------

function smootherstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * c * (c * (c * 6 - 15) + 10)
}

// Cumulative distance a unit-speed star has travelled by frame f.
// Frames [0..WARP_FULL]: constant speed → linear accumulation.
// Frames (WARP_FULL..FREEZE_FRAME): speed multiplier is 1 - smootherstep(v),
//   whose integral from 0 to v is v − v⁶ + 3v⁵ − 2.5v⁴ (integrates to exactly
//   0.5 over the full decel). After FREEZE_FRAME: motion is done.
function distTraveled(f: number): number {
  if (f <= WARP_FULL) return Math.max(0, f)
  if (f >= FREEZE_FRAME) return WARP_FULL + 0.5 * DECEL
  const v = (f - WARP_FULL) / DECEL
  return WARP_FULL + DECEL * (v - v ** 6 + 3 * v ** 5 - 2.5 * v ** 4)
}

function project(
  cx: number, cy: number,
  angle: number, dist: number,
  fov: number,
): Vec2 | null {
  if (dist <= 0.3) return null
  const s = fov / dist
  return {
    x: cx + Math.cos(angle) * s,
    y: cy + Math.sin(angle) * s * ASPECT_Y,
  }
}

function starPosAt(
  star: Star, frame: number,
  cx: number, cy: number, fov: number,
): Vec2 | null {
  return project(cx, cy, star.angle, star.initialDist - star.speed * distTraveled(frame), fov)
}

// --- rasterisation ---------------------------------------------------------

function plotAA(
  grid: Float32Array, w: number, h: number,
  x: number, y: number, amount: number,
): void {
  if (amount <= 0) return
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const put = (cx: number, cy: number, weight: number) => {
    if (weight <= 0 || cx < 0 || cx >= w || cy < 0 || cy >= h) return
    grid[cy * w + cx]! += amount * weight
  }
  put(ix, iy, (1 - fx) * (1 - fy))
  put(ix + 1, iy, fx * (1 - fy))
  put(ix, iy + 1, (1 - fx) * fy)
  put(ix + 1, iy + 1, fx * fy)
}

function drawStreak(
  grid: Float32Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  b0: number, b1: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) * 2)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    plotAA(grid, w, h, x0 + dx * t, y0 + dy * t, b0 * (1 - t) + b1 * t)
  }
}

// --- frame renderer --------------------------------------------------------

function renderFrame(
  grid: Float32Array,
  canvasW: number, canvasH: number,
  stars: Star[], frameIdx: number,
): void {
  grid.fill(0)

  const cx = (canvasW - 1) / 2
  const cy = (canvasH - 1) / 2
  // FOV tuned so the warp "tunnel" feels right on any terminal size — neither
  // squashed against the middle nor pushed off the screen.
  const fov = Math.min(canvasW, canvasH / ASPECT_Y) * 0.38

  const bgFade =
    frameIdx <= BG_FADE_START ? 1 :
    frameIdx >= BG_FADE_END ? 0 :
    1 - smootherstep((frameIdx - BG_FADE_START) / (BG_FADE_END - BG_FADE_START))

  // Text stars blend in as ordinary warp stars during full warp, then ramp to
  // peak (1×) through the decel so they're locked solid the moment motion
  // stops at FREEZE_FRAME.
  const textRamp =
    frameIdx <= WARP_FULL ? 0 :
    frameIdx >= FREEZE_FRAME ? 1 :
    smootherstep((frameIdx - WARP_FULL) / DECEL)

  const plotTrail = (star: Star, curX: number, curY: number, b: number): void => {
    plotAA(grid, canvasW, canvasH, curX, curY, b)
    let ax = curX, ay = curY, ab = b
    for (let lag = 1; lag <= TAIL_FRAMES; lag++) {
      const pt = starPosAt(star, frameIdx - lag, cx, cy, fov)
      if (!pt) break
      const dx = pt.x - ax
      const dy = pt.y - ay
      // Once per-frame motion is subpixel, further tail segments would stack
      // on top of the head and overflow the AA grid. Bail so decelerating
      // stars taper cleanly into single points.
      if (dx * dx + dy * dy < 0.5) break
      const tb = b * (1 - lag / (TAIL_FRAMES + 1))
      drawStreak(grid, canvasW, canvasH, pt.x, pt.y, ax, ay, tb, ab)
      ax = pt.x; ay = pt.y; ab = tb
    }
  }

  for (const star of stars) {
    // Post-freeze: bg is gone; text stars sit solid on their bitmap pixels.
    if (frameIdx >= FREEZE_FRAME) {
      if (!star.target) continue
      plotAA(grid, canvasW, canvasH, star.target.x, star.target.y, star.brightness)
      continue
    }

    // Warp + decel: every star (bg or text) is on its radial trajectory.
    if (!star.target && bgFade < 0.02) continue
    const cur = starPosAt(star, frameIdx, cx, cy, fov)
    if (!cur) continue

    const b = star.target
      ? star.brightness * (0.5 + 0.5 * textRamp)
      : star.brightness * bgFade
    plotTrail(star, cur.x, cur.y, b)
  }
}

// --- output ---------------------------------------------------------------

function frameToAnsi(
  grid: Float32Array,
  canvasW: number, canvasH: number,
  originX: number, originY: number,
): string {
  let out = ''
  for (let r = 0; r < canvasH; r++) {
    out += `\x1b[${originY + r};${originX}H`
    let runColor = ''
    let runText = ''
    for (let c = 0; c < canvasW; c++) {
      const b = Math.min(1, grid[r * canvasW + c]!)
      const idx = Math.min(
        LUMINANCE.length - 1,
        Math.max(0, Math.round(b * (LUMINANCE.length - 1))),
      )
      const ch = LUMINANCE[idx]!
      const color = ch === ' ' ? '' : RAMP_COLORS[idx]!
      if (color !== runColor) {
        if (runText) out += runText
        out += color
        runColor = color
        runText = ch
      } else {
        runText += ch
      }
    }
    if (runText) out += runText
    out += RESET
  }
  return out
}

async function playAnimation(
  cols: number, rows: number,
  stopRef: { stopped: boolean },
): Promise<void> {
  const canvasW = cols
  const canvasH = rows - 1 // bottom row reserved for the dismiss hint

  const stars = initStars(canvasW, canvasH)
  const grid = new Float32Array(canvasW * canvasH)

  const hint = `press any key  ·  hux ${VERSION}`
  const hintX = Math.max(1, Math.floor((cols - hint.length) / 2) + 1)
  process.stdout.write(`\x1b[${rows};${hintX}H${DIM}${hint}${RESET}`)

  for (let frameIdx = 0; frameIdx <= SETTLE_END && !stopRef.stopped; frameIdx++) {
    const frameStart = Date.now()
    renderFrame(grid, canvasW, canvasH, stars, frameIdx)
    process.stdout.write(frameToAnsi(grid, canvasW, canvasH, 1, 1))
    const elapsed = Date.now() - frameStart
    await sleep(Math.max(0, FRAME_MS - elapsed))
  }

  // After SETTLE_END the hux wordmark is solid — the final rendered frame
  // stays on screen. Idle until the keypress handler flips stopRef.
  while (!stopRef.stopped) {
    await sleep(100)
  }
}

function renderMinimal(cols: number, rows: number): void {
  const lines = [
    'welcome to hux',
    'a tmux-flavoured terminal window manager',
    '',
    `press any key to begin  ·  hux ${VERSION}`,
  ]
  const colors = [ACCENT, MUTED, '', DIM]
  const startY = Math.max(1, Math.floor((rows - lines.length) / 2))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    const x = Math.max(1, Math.floor((cols - line.length) / 2) + 1)
    const y = startY + i
    process.stdout.write(`\x1b[${y};${x}H${colors[i]}${line}${RESET}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForKey(): Promise<boolean> {
  return new Promise(resolve => {
    const wasRaw = process.stdin.isRaw === true
    try { process.stdin.setRawMode(true) } catch {}
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData)
      try { process.stdin.setRawMode(wasRaw) } catch {}
      process.stdin.pause()
      const ctrlC = chunk.length > 0 && chunk[0] === 0x03
      resolve(!ctrlC)
    }
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

// Test hook — renders one frame at an arbitrary canvas size as plain ASCII,
// useful for visual QA without spinning up a terminal.
export function __renderFramePreview(
  canvasW: number, canvasH: number, frameIdx: number,
): string {
  const stars = initStars(canvasW, canvasH)
  const grid = new Float32Array(canvasW * canvasH)
  renderFrame(grid, canvasW, canvasH, stars, frameIdx)
  const lines: string[] = []
  for (let r = 0; r < canvasH; r++) {
    let row = ''
    for (let c = 0; c < canvasW; c++) {
      const b = Math.min(1, grid[r * canvasW + c]!)
      const idx = Math.min(
        LUMINANCE.length - 1,
        Math.max(0, Math.round(b * (LUMINANCE.length - 1))),
      )
      row += LUMINANCE[idx]
    }
    lines.push(row.trimEnd())
  }
  return lines.join('\n')
}
