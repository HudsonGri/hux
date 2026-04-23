export type MouseEvent =
  | { raw: string; kind: 'press'; x: number; y: number; shift: boolean }
  | { raw: string; kind: 'rpress'; x: number; y: number; shift: boolean }
  | { raw: string; kind: 'drag'; x: number; y: number; shift: boolean }
  | { raw: string; kind: 'release'; x: number; y: number; shift: boolean }
  | { raw: string; kind: 'hover'; x: number; y: number }
  | { raw: string; kind: 'wheel'; direction: 'up' | 'down'; x: number; y: number; shift: boolean }
  | { raw: string; kind: 'ignore'; x: number; y: number }

export function consumeMouseSequence(input: string): MouseEvent | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input)
  if (!match) return null

  const [, codeRaw, xRaw, yRaw, suffix] = match
  const code = Number(codeRaw)
  const x = Number(xRaw) - 1
  const y = Number(yRaw) - 1

  const isMotion = (code & 32) !== 0
  const isWheel = (code & 64) !== 0
  const shift = (code & 4) !== 0
  const button = code & 3

  if (isWheel) {
    const direction: 'up' | 'down' = (code & 1) ? 'down' : 'up'
    return { raw: match[0]!, kind: 'wheel', direction, x, y, shift }
  }
  if (suffix === 'm') {
    if (button === 0) return { raw: match[0]!, kind: 'release', x, y, shift }
    return { raw: match[0]!, kind: 'ignore', x, y }
  }
  if (isMotion && button === 0) return { raw: match[0]!, kind: 'drag', x, y, shift }
  if (isMotion && button === 3) return { raw: match[0]!, kind: 'hover', x, y }
  if (!isMotion && button === 0) return { raw: match[0]!, kind: 'press', x, y, shift }
  if (!isMotion && button === 2) return { raw: match[0]!, kind: 'rpress', x, y, shift }
  return { raw: match[0]!, kind: 'ignore', x, y }
}
