import { deflateSync } from 'node:zlib'

const RGB_FLAG = 0x01000000

export type RgbBuffer = {
  width: number
  height: number
  data: Buffer
}

export type PaletteCell = {
  ch: string
  fg?: number
  bg?: number
  bold?: boolean
}

export function kittyGraphicsSupported(): boolean {
  if (process.env.HUX_DISABLE_GRAPHICS === '1') return false
  if (process.env.HUX_ENABLE_GRAPHICS === '1') return true
  if (process.env.KITTY_WINDOW_ID) return true
  const tp = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  if (tp.includes('ghostty') || tp.includes('kitty') || tp.includes('wezterm')) {
    return true
  }
  const term = (process.env.TERM ?? '').toLowerCase()
  if (term.includes('kitty')) return true
  return false
}

const STD_16: readonly (readonly [number, number, number])[] = [
  [12, 12, 12],
  [172, 53, 44],
  [63, 156, 53],
  [191, 141, 0],
  [51, 119, 204],
  [172, 65, 180],
  [49, 165, 204],
  [195, 195, 195],
  [100, 100, 100],
  [239, 84, 73],
  [117, 210, 100],
  [232, 200, 29],
  [77, 155, 240],
  [214, 110, 219],
  [81, 205, 240],
  [246, 246, 246],
]

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const

export function paletteToRgb(
  value: number | undefined,
  fallback: readonly [number, number, number] = [30, 30, 30],
): [number, number, number] {
  if (value === undefined) return [fallback[0], fallback[1], fallback[2]]
  if (value >= RGB_FLAG) {
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }
  if (value < 0) return [fallback[0], fallback[1], fallback[2]]
  if (value < 16) {
    const c = STD_16[value]!
    return [c[0], c[1], c[2]]
  }
  if (value < 232) {
    const i = value - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    return [CUBE_STEPS[r]!, CUBE_STEPS[g]!, CUBE_STEPS[b]!]
  }
  if (value < 256) {
    const v = 8 + (value - 232) * 10
    return [v, v, v]
  }
  return [fallback[0], fallback[1], fallback[2]]
}

const SRGB_TO_LINEAR_U16 = new Uint32Array(256)
const LINEAR_U16_TO_SRGB = new Uint8Array(65536)

for (let i = 0; i < 256; i++) {
  const s = i / 255
  const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  SRGB_TO_LINEAR_U16[i] = Math.round(lin * 65535)
}
for (let i = 0; i < 65536; i++) {
  const lin = i / 65535
  const s =
    lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055
  LINEAR_U16_TO_SRGB[i] = Math.min(255, Math.max(0, Math.round(s * 255)))
}

export function downsample(src: RgbBuffer, factor: number): RgbBuffer {
  if (factor < 2) return src
  const srcW = src.width
  const srcH = src.height
  const dW = Math.max(1, Math.floor(srcW / factor))
  const dH = Math.max(1, Math.floor(srcH / factor))
  const dst = Buffer.alloc(dW * dH * 3)
  const srcData = src.data
  const samples = factor * factor
  const s2l = SRGB_TO_LINEAR_U16
  const l2s = LINEAR_U16_TO_SRGB

  for (let y = 0; y < dH; y++) {
    const sy0 = y * factor
    for (let x = 0; x < dW; x++) {
      const sx0 = x * factor
      let rSum = 0
      let gSum = 0
      let bSum = 0
      for (let dy = 0; dy < factor; dy++) {
        const rowBase = (sy0 + dy) * srcW
        for (let dx = 0; dx < factor; dx++) {
          const o = (rowBase + sx0 + dx) * 3
          rSum += s2l[srcData[o]!]!
          gSum += s2l[srcData[o + 1]!]!
          bSum += s2l[srcData[o + 2]!]!
        }
      }
      const o = (y * dW + x) * 3
      dst[o] = l2s[(rSum / samples) | 0]!
      dst[o + 1] = l2s[(gSum / samples) | 0]!
      dst[o + 2] = l2s[(bSum / samples) | 0]!
    }
  }
  return { width: dW, height: dH, data: dst }
}

export function createRgbBuffer(
  width: number,
  height: number,
  bg: readonly [number, number, number] = [30, 30, 30],
): RgbBuffer {
  const data = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const o = i * 3
    data[o] = bg[0]
    data[o + 1] = bg[1]
    data[o + 2] = bg[2]
  }
  return { width, height, data }
}

export type RasterizeOptions = {
  cells: readonly (readonly PaletteCell[])[]
  cols: number
  rows: number
  totalWidthPx: number
  totalHeightPx: number
  defaultBg?: readonly [number, number, number]
  defaultFg?: readonly [number, number, number]
}

const DEFAULT_BG: readonly [number, number, number] = [30, 30, 30]
const DEFAULT_FG: readonly [number, number, number] = [212, 212, 212]

export function rasterizePane(opts: RasterizeOptions): RgbBuffer {
  const cols = Math.max(1, opts.cols)
  const rows = Math.max(1, opts.rows)
  const pxW = Math.max(1, opts.totalWidthPx)
  const pxH = Math.max(1, opts.totalHeightPx)
  const defaultBg = opts.defaultBg ?? DEFAULT_BG
  const defaultFg = opts.defaultFg ?? DEFAULT_FG
  const buf = createRgbBuffer(pxW, pxH, defaultBg)
  const data = buf.data

  const colEdges = new Int32Array(cols + 1)
  for (let c = 0; c <= cols; c++) colEdges[c] = Math.round((c * pxW) / cols)
  const rowEdges = new Int32Array(rows + 1)
  for (let r = 0; r <= rows; r++) rowEdges[r] = Math.round((r * pxH) / rows)

  const rowLimit = Math.min(opts.cells.length, rows)
  for (let r = 0; r < rowLimit; r++) {
    const row = opts.cells[r]
    if (!row) continue
    const y0 = rowEdges[r]!
    const ch = rowEdges[r + 1]! - y0
    if (ch <= 0) continue
    const colLimit = Math.min(row.length, cols)
    for (let c = 0; c < colLimit; c++) {
      const cell = row[c]
      if (!cell) continue
      const x0 = colEdges[c]!
      const cw = colEdges[c + 1]! - x0
      if (cw <= 0) continue
      const bg = cell.bg !== undefined ? paletteToRgb(cell.bg, defaultBg) : defaultBg
      fillBlock(data, pxW, x0, y0, cw, ch, bg[0], bg[1], bg[2])
      const char = cell.ch === '' ? ' ' : cell.ch
      if (char === ' ') continue
      const fg =
        cell.fg !== undefined ? paletteToRgb(cell.fg, defaultFg) : defaultFg
      const fgR = cell.bold ? brighten(fg[0]) : fg[0]
      const fgG = cell.bold ? brighten(fg[1]) : fg[1]
      const fgB = cell.bold ? brighten(fg[2]) : fg[2]
      paintGlyph(data, pxW, x0, y0, cw, ch, char, fgR, fgG, fgB)
      if (cell.bold && cw > 1) {
        paintGlyph(data, pxW, x0 + 1, y0, cw - 1, ch, char, fgR, fgG, fgB)
      }
    }
  }
  return buf
}

function brighten(v: number): number {
  return Math.min(255, Math.round(v + (255 - v) * 0.25))
}

function fillBlock(
  data: Buffer,
  stride: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): void {
  const xStart = Math.max(0, x0)
  const yStart = Math.max(0, y0)
  const xEnd = Math.min(stride, x0 + w)
  const yEnd = Math.min(Math.floor(data.length / 3 / stride), y0 + h)
  for (let y = yStart; y < yEnd; y++) {
    const rowBase = y * stride
    for (let x = xStart; x < xEnd; x++) {
      const o = (rowBase + x) * 3
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
    }
  }
}

function paintGlyph(
  data: Buffer,
  stride: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  char: string,
  r: number,
  g: number,
  b: number,
): void {
  const kind = glyphKind(char)
  if (kind === 'none') return
  if (kind === 'full') {
    fillBlock(data, stride, x0, y0, w, h, r, g, b)
    return
  }
  if (kind === 'upper') {
    fillBlock(data, stride, x0, y0, w, Math.max(1, Math.floor(h / 2)), r, g, b)
    return
  }
  if (kind === 'lower') {
    const half = Math.max(1, Math.floor(h / 2))
    fillBlock(data, stride, x0, y0 + h - half, w, half, r, g, b)
    return
  }
  if (kind === 'left') {
    fillBlock(data, stride, x0, y0, Math.max(1, Math.floor(w / 2)), h, r, g, b)
    return
  }
  if (kind === 'right') {
    const half = Math.max(1, Math.floor(w / 2))
    fillBlock(data, stride, x0 + w - half, y0, half, h, r, g, b)
    return
  }
  if (kind === 'vline') {
    const thick = Math.max(1, Math.floor(w / 4))
    fillBlock(data, stride, x0 + Math.floor((w - thick) / 2), y0, thick, h, r, g, b)
    return
  }
  if (kind === 'hline') {
    const thick = Math.max(1, Math.floor(h / 4))
    fillBlock(data, stride, x0, y0 + Math.floor((h - thick) / 2), w, thick, r, g, b)
    return
  }
  const glyph = getGlyph(char)
  if (glyph && w >= GLYPH_WIDTH && h >= GLYPH_HEIGHT) {
    paintBitmapGlyph(data, stride, x0, y0, w, h, glyph, r, g, b)
    return
  }
  const density = glyph ? 0.55 : densityOf(char)
  if (density <= 0) return
  const blobW = Math.max(1, Math.round(w * density))
  const blobH = Math.max(1, Math.round(h * density))
  const ox = x0 + Math.floor((w - blobW) / 2)
  const oy = y0 + Math.floor((h - blobH) / 2)
  fillBlock(data, stride, ox, oy, blobW, blobH, r, g, b)
}

function paintBitmapGlyph(
  data: Buffer,
  stride: number,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  glyph: Uint8Array,
  r: number,
  g: number,
  b: number,
): void {
  const gw = GLYPH_WIDTH
  const gh = GLYPH_HEIGHT
  const scale = Math.max(1, Math.min(Math.floor(cw / gw), Math.floor(ch / gh)))
  const drawW = gw * scale
  const drawH = gh * scale
  const offsetX = x0 + Math.floor((cw - drawW) / 2)
  const offsetY = y0 + Math.floor((ch - drawH) / 2)
  for (let gy = 0; gy < gh; gy++) {
    const rowBits = glyph[gy]!
    for (let gx = 0; gx < gw; gx++) {
      if ((rowBits & (1 << (gw - 1 - gx))) === 0) continue
      fillBlock(
        data,
        stride,
        offsetX + gx * scale,
        offsetY + gy * scale,
        scale,
        scale,
        r,
        g,
        b,
      )
    }
  }
}

type GlyphKind =
  | 'none'
  | 'full'
  | 'upper'
  | 'lower'
  | 'left'
  | 'right'
  | 'vline'
  | 'hline'
  | 'default'

function glyphKind(char: string): GlyphKind {
  switch (char) {
    case '█':
    case '▇':
    case '▆':
      return 'full'
    case '▀':
    case '▔':
      return 'upper'
    case '▄':
    case '▃':
    case '▂':
    case '▁':
    case '_':
      return 'lower'
    case '▌':
    case '▍':
    case '▎':
    case '▏':
      return 'left'
    case '▐':
    case '▕':
      return 'right'
    case '│':
    case '┃':
    case '║':
    case '╎':
    case '╏':
    case '╵':
    case '╷':
    case '|':
      return 'vline'
    case '─':
    case '━':
    case '═':
    case '╌':
    case '╍':
    case '╴':
    case '╶':
      return 'hline'
    default:
      return 'default'
  }
}

function densityOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 32) return 0
  if ('.,\''.includes(char)) return 0.2
  if (';:`"'.includes(char)) return 0.25
  if ('-_~^*+='.includes(char)) return 0.3
  if ('!?|/\\'.includes(char)) return 0.35
  if ('()[]{}<>'.includes(char)) return 0.4
  if (code === 0x2591) return 0.3
  if (code === 0x2592) return 0.55
  if (code === 0x2593) return 0.75
  if (code >= 0x2500 && code <= 0x257f) return 0.45
  if (code >= 0x2580 && code <= 0x259f) return 0.55
  return 0.55
}

const GLYPH_WIDTH = 6
const GLYPH_HEIGHT = 10

const GLYPH_STRINGS: Record<string, string> = {
  ' ': '......|......|......|......|......|......|......|......|......|......',
  '!': '......|..#...|..#...|..#...|..#...|..#...|......|..#...|......|......',
  '"': '......|.#.#..|.#.#..|.#.#..|......|......|......|......|......|......',
  '#': '......|.#.#..|.#.#..|#####.|.#.#..|#####.|.#.#..|.#.#..|......|......',
  '$': '......|..#...|.####.|#.#...|.###..|..#.#.|####..|..#...|......|......',
  '%': '......|##..#.|##.#..|...#..|..#...|.#..#.|.#.##.|#..##.|......|......',
  '&': '......|.##...|#..#..|#.#...|.##...|#.#.#.|#..#..|.##.#.|......|......',
  "'": '......|..#...|..#...|......|......|......|......|......|......|......',
  '(': '......|...#..|..#...|.#....|.#....|.#....|..#...|...#..|......|......',
  ')': '......|.#....|..#...|...#..|...#..|...#..|..#...|.#....|......|......',
  '*': '......|......|..#...|#.#.#.|.###..|#.#.#.|..#...|......|......|......',
  '+': '......|......|..#...|..#...|#####.|..#...|..#...|......|......|......',
  ',': '......|......|......|......|......|......|......|..#...|.#....|......',
  '-': '......|......|......|......|#####.|......|......|......|......|......',
  '.': '......|......|......|......|......|......|......|..#...|......|......',
  '/': '......|....#.|....#.|...#..|..#...|.#....|#.....|#.....|......|......',
  '0': '......|.###..|#...#.|#..##.|#.#.#.|##..#.|#...#.|.###..|......|......',
  '1': '......|..#...|.##...|..#...|..#...|..#...|..#...|.###..|......|......',
  '2': '......|.###..|#...#.|....#.|...#..|..#...|.#....|#####.|......|......',
  '3': '......|.###..|#...#.|....#.|..##..|....#.|#...#.|.###..|......|......',
  '4': '......|...#..|..##..|.#.#..|#..#..|#####.|...#..|...#..|......|......',
  '5': '......|#####.|#.....|####..|....#.|....#.|#...#.|.###..|......|......',
  '6': '......|..##..|.#....|#.....|####..|#...#.|#...#.|.###..|......|......',
  '7': '......|#####.|....#.|...#..|..#...|.#....|.#....|.#....|......|......',
  '8': '......|.###..|#...#.|#...#.|.###..|#...#.|#...#.|.###..|......|......',
  '9': '......|.###..|#...#.|#...#.|.####.|....#.|...#..|.##...|......|......',
  ':': '......|......|......|..#...|......|......|..#...|......|......|......',
  ';': '......|......|......|..#...|......|......|..#...|.#....|......|......',
  '<': '......|...#..|..#...|.#....|#.....|.#....|..#...|...#..|......|......',
  '=': '......|......|......|#####.|......|#####.|......|......|......|......',
  '>': '......|.#....|..#...|...#..|....#.|...#..|..#...|.#....|......|......',
  '?': '......|.###..|#...#.|....#.|...#..|..#...|......|..#...|......|......',
  '@': '......|.###..|#...#.|#.###.|#.#.#.|#.###.|#.....|.####.|......|......',
  'A': '......|..#...|.#.#..|#...#.|#...#.|#####.|#...#.|#...#.|......|......',
  'B': '......|####..|#...#.|#...#.|####..|#...#.|#...#.|####..|......|......',
  'C': '......|.####.|#....#|#.....|#.....|#.....|#....#|.####.|......|......',
  'D': '......|####..|#...#.|#...#.|#...#.|#...#.|#...#.|####..|......|......',
  'E': '......|#####.|#.....|#.....|####..|#.....|#.....|#####.|......|......',
  'F': '......|#####.|#.....|#.....|####..|#.....|#.....|#.....|......|......',
  'G': '......|.####.|#....#|#.....|#.....|#..###|#....#|.####.|......|......',
  'H': '......|#...#.|#...#.|#...#.|#####.|#...#.|#...#.|#...#.|......|......',
  'I': '......|.###..|..#...|..#...|..#...|..#...|..#...|.###..|......|......',
  'J': '......|..###.|...#..|...#..|...#..|...#..|#..#..|.##...|......|......',
  'K': '......|#...#.|#..#..|#.#...|##....|#.#...|#..#..|#...#.|......|......',
  'L': '......|#.....|#.....|#.....|#.....|#.....|#.....|#####.|......|......',
  'M': '......|#...#.|##.##.|#.#.#.|#.#.#.|#...#.|#...#.|#...#.|......|......',
  'N': '......|#...#.|##..#.|#.#.#.|#.#.#.|#..##.|#...#.|#...#.|......|......',
  'O': '......|.###..|#...#.|#...#.|#...#.|#...#.|#...#.|.###..|......|......',
  'P': '......|####..|#...#.|#...#.|####..|#.....|#.....|#.....|......|......',
  'Q': '......|.###..|#...#.|#...#.|#...#.|#.#.#.|#..#..|.##.#.|......|......',
  'R': '......|####..|#...#.|#...#.|####..|#.#...|#..#..|#...#.|......|......',
  'S': '......|.####.|#.....|#.....|.###..|....#.|....#.|####..|......|......',
  'T': '......|#####.|..#...|..#...|..#...|..#...|..#...|..#...|......|......',
  'U': '......|#...#.|#...#.|#...#.|#...#.|#...#.|#...#.|.###..|......|......',
  'V': '......|#...#.|#...#.|#...#.|#...#.|#...#.|.#.#..|..#...|......|......',
  'W': '......|#...#.|#...#.|#...#.|#.#.#.|#.#.#.|#.#.#.|.#.#..|......|......',
  'X': '......|#...#.|#...#.|.#.#..|..#...|.#.#..|#...#.|#...#.|......|......',
  'Y': '......|#...#.|#...#.|#...#.|.#.#..|..#...|..#...|..#...|......|......',
  'Z': '......|#####.|....#.|...#..|..#...|.#....|#.....|#####.|......|......',
  '[': '......|.###..|.#....|.#....|.#....|.#....|.#....|.#....|.###..|......',
  '\\': '......|#.....|#.....|.#....|..#...|...#..|....#.|....#.|......|......',
  ']': '......|.###..|...#..|...#..|...#..|...#..|...#..|...#..|.###..|......',
  '^': '......|..#...|.#.#..|#...#.|......|......|......|......|......|......',
  '_': '......|......|......|......|......|......|......|......|......|#####.',
  '`': '......|.#....|..#...|......|......|......|......|......|......|......',
  'a': '......|......|......|.###..|....#.|.####.|#...#.|.####.|......|......',
  'b': '......|#.....|#.....|####..|#...#.|#...#.|#...#.|####..|......|......',
  'c': '......|......|......|.####.|#.....|#.....|#.....|.####.|......|......',
  'd': '......|....#.|....#.|.####.|#...#.|#...#.|#...#.|.####.|......|......',
  'e': '......|......|......|.###..|#...#.|#####.|#.....|.###..|......|......',
  'f': '......|..##..|.#..#.|.#....|####..|.#....|.#....|.#....|......|......',
  'g': '......|......|......|.####.|#...#.|#...#.|.####.|....#.|.###..|......',
  'h': '......|#.....|#.....|#.##..|##..#.|#...#.|#...#.|#...#.|......|......',
  'i': '......|..#...|......|.##...|..#...|..#...|..#...|.###..|......|......',
  'j': '......|...#..|......|..##..|...#..|...#..|...#..|#..#..|.##...|......',
  'k': '......|#.....|#.....|#..#..|#.#...|##....|#.#...|#..#..|......|......',
  'l': '......|.##...|..#...|..#...|..#...|..#...|..#...|.###..|......|......',
  'm': '......|......|......|##.##.|#.#.#.|#.#.#.|#.#.#.|#.#.#.|......|......',
  'n': '......|......|......|#.##..|##..#.|#...#.|#...#.|#...#.|......|......',
  'o': '......|......|......|.###..|#...#.|#...#.|#...#.|.###..|......|......',
  'p': '......|......|......|####..|#...#.|#...#.|####..|#.....|#.....|......',
  'q': '......|......|......|.####.|#...#.|#...#.|.####.|....#.|....#.|......',
  'r': '......|......|......|#.##..|##..#.|#.....|#.....|#.....|......|......',
  's': '......|......|......|.####.|#.....|.###..|....#.|####..|......|......',
  't': '......|.#....|.#....|####..|.#....|.#....|.#..#.|..##..|......|......',
  'u': '......|......|......|#...#.|#...#.|#...#.|#...#.|.####.|......|......',
  'v': '......|......|......|#...#.|#...#.|#...#.|.#.#..|..#...|......|......',
  'w': '......|......|......|#...#.|#...#.|#.#.#.|#.#.#.|.#.#..|......|......',
  'x': '......|......|......|#...#.|.#.#..|..#...|.#.#..|#...#.|......|......',
  'y': '......|......|......|#...#.|#...#.|#...#.|.####.|....#.|.###..|......',
  'z': '......|......|......|#####.|...#..|..#...|.#....|#####.|......|......',
  '{': '......|..##..|..#...|..#...|.#....|..#...|..#...|..##..|......|......',
  '|': '......|..#...|..#...|..#...|..#...|..#...|..#...|..#...|......|......',
  '}': '......|.##...|..#...|..#...|...#..|..#...|..#...|.##...|......|......',
  '~': '......|......|.#..#.|#.##..|......|......|......|......|......|......',
}

const GLYPH_CACHE: Map<string, Uint8Array> = new Map()

function getGlyph(char: string): Uint8Array | null {
  const cached = GLYPH_CACHE.get(char)
  if (cached) return cached
  const raw = GLYPH_STRINGS[char]
  if (!raw) return null
  const rows = raw.split('|')
  if (rows.length !== GLYPH_HEIGHT) return null
  const bytes = new Uint8Array(GLYPH_HEIGHT)
  for (let y = 0; y < GLYPH_HEIGHT; y++) {
    let bits = 0
    const row = rows[y]!
    for (let x = 0; x < GLYPH_WIDTH; x++) {
      if (row[x] === '#') bits |= 1 << (GLYPH_WIDTH - 1 - x)
    }
    bytes[y] = bits
  }
  GLYPH_CACHE.set(char, bytes)
  return bytes
}

export type KittyTransmitOpts = {
  imageId: number
  buffer: RgbBuffer
  displayCols: number
  displayRows: number
  cursorRow: number
  cursorCol: number
  zIndex?: number
  placementId?: number
}

const CHUNK_SIZE = 4096

export function kittyTransmitSequence(opts: KittyTransmitOpts): string {
  const {
    imageId,
    buffer,
    displayCols,
    displayRows,
    cursorRow,
    cursorCol,
    zIndex = 1,
    placementId,
  } = opts
  const compressed = deflateSync(buffer.data)
  const payload = compressed.toString('base64')
  let out = `\x1b[${cursorRow};${cursorCol}H`
  const baseCtl = [
    `a=T`,
    `f=24`,
    `o=z`,
    `s=${buffer.width}`,
    `v=${buffer.height}`,
    `i=${imageId}`,
    `c=${displayCols}`,
    `r=${displayRows}`,
    `z=${zIndex}`,
    `C=1`,
    `q=2`,
  ]
  if (placementId !== undefined) baseCtl.push(`p=${placementId}`)
  const firstCtl = baseCtl.slice()
  const hasMore = payload.length > CHUNK_SIZE
  if (hasMore) firstCtl.push('m=1')
  const first = payload.slice(0, CHUNK_SIZE)
  out += `\x1b_G${firstCtl.join(',')};${first}\x1b\\`
  if (hasMore) {
    for (let i = CHUNK_SIZE; i < payload.length; i += CHUNK_SIZE) {
      const chunk = payload.slice(i, i + CHUNK_SIZE)
      const isLast = i + CHUNK_SIZE >= payload.length
      const ctl = isLast ? 'm=0,q=2' : 'm=1,q=2'
      out += `\x1b_G${ctl};${chunk}\x1b\\`
    }
  }
  return out
}

export function kittyDeleteSequence(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`
}
