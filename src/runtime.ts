import {
  Align,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  FlexNode,
} from './layout/flex.js'

type SizeValue = number | `${number}%`

export type BoxStyle = {
  width?: SizeValue
  height?: SizeValue
  minWidth?: SizeValue
  minHeight?: SizeValue
  maxWidth?: SizeValue
  maxHeight?: SizeValue
  flexDirection?: 'row' | 'column'
  flexGrow?: number
  flexShrink?: number
  justifyContent?:
    | 'flex-start'
    | 'center'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
  alignItems?: 'stretch' | 'flex-start' | 'center' | 'flex-end'
  padding?: number
  paddingX?: number
  paddingY?: number
  paddingTop?: number
  paddingBottom?: number
  paddingLeft?: number
  paddingRight?: number
  gap?: number
  rowGap?: number
  columnGap?: number
}

export type BorderPreset = 'none' | 'normal' | 'focused' | 'accent' | 'dashed'
export type TextAlign = 'left' | 'center' | 'right'
export type TextVerticalAlign = 'top' | 'middle' | 'bottom'

export type CellStyle = {
  fg?: number
  bg?: number
  bold?: boolean
}

export type Appearance = {
  fill?: CellStyle
  border?: CellStyle
  text?: CellStyle
}

export type TextOverflow = 'head' | 'tail'

export type PaintRect = {
  x: number
  y: number
  width: number
  height: number
}

export type Painter = {
  set: (x: number, y: number, char: string, style?: CellStyle) => void
  fillRect: (
    x: number,
    y: number,
    width: number,
    height: number,
    char?: string,
    style?: CellStyle,
  ) => void
  writeText: (x: number, y: number, text: string, style?: CellStyle) => void
}

export type PaintFn = (painter: Painter, rect: PaintRect) => void

export type ViewNode = {
  id?: string
  style?: BoxStyle
  border?: BorderPreset
  appearance?: Appearance
  fillChar?: string
  text?: string | string[]
  textAlign?: TextAlign
  textVerticalAlign?: TextVerticalAlign
  textOverflow?: TextOverflow
  paint?: PaintFn
  children?: ViewNode[]
}

type LayoutNode = ViewNode & {
  flexNode: FlexNode
  children: LayoutNode[]
}

type BorderChars = {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
}

export type HitRegion = {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type RenderResult = {
  output: string
  hitRegions: HitRegion[]
}

export type Overlay = {
  x: number
  y: number
  width: number
  height: number
  node: ViewNode
}

export type RenderOptions = {
  color?: boolean
  overlays?: Overlay[]
}

type Cell = {
  char: string
  style?: CellStyle
}

const BORDERS: Record<Exclude<BorderPreset, 'none'>, BorderChars> = {
  normal: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
  },
  focused: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
  },
  accent: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
  dashed: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '╌',
    vertical: '╎',
  },
}

class ScreenBuffer {
  private readonly rows: Cell[][]

  constructor(
    readonly width: number,
    readonly height: number,
    fill = ' ',
  ) {
    this.rows = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({ char: fill })),
    )
  }

  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    char = ' ',
    style?: CellStyle,
  ): void {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        this.set(x + col, y + row, char, style)
      }
    }
  }

  set(x: number, y: number, char: string, style?: CellStyle): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return
    }

    this.rows[y]![x] = {
      char,
      style,
    }
  }

  writeText(x: number, y: number, text: string, style?: CellStyle): void {
    const chars = Array.from(text)
    for (let i = 0; i < chars.length; i++) {
      this.set(x + i, y, chars[i]!, style)
    }
  }

  toString(color = true): string {
    if (!color) {
      return this.rows
        .map(row => row.map(cell => cell.char).join(''))
        .join('\n')
    }

    return this.rows
      .map(row => {
        let line = ''
        let currentStyle: CellStyle | undefined

        for (const cell of row) {
          if (!sameStyle(currentStyle, cell.style)) {
            line += styleToAnsi(cell.style)
            currentStyle = cloneStyle(cell.style)
          }
          line += cell.char
        }

        if (currentStyle) {
          line += '\x1b[0m'
        }

        return line
      })
      .join('\n')
  }
}

export function renderView(
  rootView: ViewNode,
  width: number,
  height: number,
  { color = true, overlays = [] }: RenderOptions = {},
): RenderResult {
  const root = buildLayoutTree(rootView)
  root.flexNode.setWidth(width)
  root.flexNode.setHeight(height)
  root.flexNode.calculateLayout(width, height, Direction.LTR)

  const screen = new ScreenBuffer(width, height)
  const hitRegions: HitRegion[] = []
  drawLayoutNode(root, screen, hitRegions, 0, 0)
  root.flexNode.freeRecursive()

  for (const overlay of overlays) {
    const overlayRoot = buildLayoutTree(overlay.node)
    overlayRoot.flexNode.setWidth(overlay.width)
    overlayRoot.flexNode.setHeight(overlay.height)
    overlayRoot.flexNode.calculateLayout(overlay.width, overlay.height, Direction.LTR)
    drawLayoutNode(overlayRoot, screen, hitRegions, overlay.x, overlay.y)
    overlayRoot.flexNode.freeRecursive()
  }

  return {
    output: screen.toString(color),
    hitRegions,
  }
}

function buildLayoutTree(view: ViewNode): LayoutNode {
  const flexNode = new FlexNode()
  applyStyle(flexNode, view.style ?? {}, view.border ?? 'none')

  const children = (view.children ?? []).map(buildLayoutTree)
  children.forEach((child, index) => {
    flexNode.insertChild(child.flexNode, index)
  })

  return {
    ...view,
    children,
    flexNode,
  }
}

function applyStyle(node: FlexNode, style: BoxStyle, border: BorderPreset): void {
  if (style.width !== undefined) {
    setSize(node.setWidth.bind(node), node.setWidthPercent.bind(node), style.width)
  }
  if (style.height !== undefined) {
    setSize(node.setHeight.bind(node), node.setHeightPercent.bind(node), style.height)
  }
  if (style.minWidth !== undefined) {
    setSize(
      node.setMinWidth.bind(node),
      node.setMinWidthPercent.bind(node),
      style.minWidth,
    )
  }
  if (style.minHeight !== undefined) {
    setSize(
      node.setMinHeight.bind(node),
      node.setMinHeightPercent.bind(node),
      style.minHeight,
    )
  }
  if (style.maxWidth !== undefined) {
    setSize(
      node.setMaxWidth.bind(node),
      node.setMaxWidthPercent.bind(node),
      style.maxWidth,
    )
  }
  if (style.maxHeight !== undefined) {
    setSize(
      node.setMaxHeight.bind(node),
      node.setMaxHeightPercent.bind(node),
      style.maxHeight,
    )
  }

  node.setFlexDirection(
    style.flexDirection === 'row' ? FlexDirection.Row : FlexDirection.Column,
  )
  node.setFlexGrow(style.flexGrow ?? 0)
  node.setFlexShrink(style.flexShrink ?? 0)
  node.setJustifyContent(mapJustify(style.justifyContent))
  node.setAlignItems(mapAlign(style.alignItems))

  if (style.padding !== undefined) {
    node.setPadding(Edge.All, style.padding)
  }
  if (style.paddingX !== undefined) {
    node.setPadding(Edge.Horizontal, style.paddingX)
  }
  if (style.paddingY !== undefined) {
    node.setPadding(Edge.Vertical, style.paddingY)
  }
  if (style.paddingTop !== undefined) {
    node.setPadding(Edge.Top, style.paddingTop)
  }
  if (style.paddingBottom !== undefined) {
    node.setPadding(Edge.Bottom, style.paddingBottom)
  }
  if (style.paddingLeft !== undefined) {
    node.setPadding(Edge.Left, style.paddingLeft)
  }
  if (style.paddingRight !== undefined) {
    node.setPadding(Edge.Right, style.paddingRight)
  }

  if (style.gap !== undefined) {
    node.setGap(Gutter.All, style.gap)
  }
  if (style.columnGap !== undefined) {
    node.setGap(Gutter.Column, style.columnGap)
  }
  if (style.rowGap !== undefined) {
    node.setGap(Gutter.Row, style.rowGap)
  }

  if (border !== 'none') {
    node.setBorder(Edge.All, 1)
  }
}

function setSize(
  setPoint: (value: number) => void,
  setPercent: (value: number) => void,
  value: SizeValue,
): void {
  if (typeof value === 'string') {
    setPercent(Number.parseInt(value, 10))
    return
  }

  setPoint(value)
}

function mapJustify(value: BoxStyle['justifyContent']): Justify {
  switch (value) {
    case 'center':
      return Justify.Center
    case 'flex-end':
      return Justify.FlexEnd
    case 'space-between':
      return Justify.SpaceBetween
    case 'space-around':
      return Justify.SpaceAround
    case 'space-evenly':
      return Justify.SpaceEvenly
    default:
      return Justify.FlexStart
  }
}

function mapAlign(value: BoxStyle['alignItems']): Align {
  switch (value) {
    case 'flex-start':
      return Align.FlexStart
    case 'center':
      return Align.Center
    case 'flex-end':
      return Align.FlexEnd
    default:
      return Align.Stretch
  }
}

function drawLayoutNode(
  node: LayoutNode,
  screen: ScreenBuffer,
  hitRegions: HitRegion[],
  offsetX: number,
  offsetY: number,
): void {
  const x = offsetX + Math.floor(node.flexNode.getComputedLeft())
  const y = offsetY + Math.floor(node.flexNode.getComputedTop())
  const width = Math.floor(node.flexNode.getComputedWidth())
  const height = Math.floor(node.flexNode.getComputedHeight())

  if (width <= 0 || height <= 0) {
    return
  }

  if (node.id) {
    hitRegions.push({
      id: node.id,
      x,
      y,
      width,
      height,
    })
  }

  if (node.fillChar) {
    screen.fillRect(
      x,
      y,
      width,
      height,
      node.fillChar,
      node.appearance?.fill,
    )
  } else if (node.appearance?.fill?.bg !== undefined) {
    screen.fillRect(x, y, width, height, ' ', node.appearance.fill)
  }

  if (node.border && node.border !== 'none') {
    drawBorder(
      screen,
      x,
      y,
      width,
      height,
      BORDERS[node.border],
      node.appearance?.border,
    )
  }

  if (node.text) {
    drawText(node, screen, x, y, width, height)
  }

  if (node.paint) {
    const borderLeft = Math.floor(node.flexNode.getComputedBorder(Edge.Left))
    const borderRight = Math.floor(node.flexNode.getComputedBorder(Edge.Right))
    const borderTop = Math.floor(node.flexNode.getComputedBorder(Edge.Top))
    const borderBottom = Math.floor(node.flexNode.getComputedBorder(Edge.Bottom))
    const paddingLeft = Math.floor(node.flexNode.getComputedPadding(Edge.Left))
    const paddingRight = Math.floor(node.flexNode.getComputedPadding(Edge.Right))
    const paddingTop = Math.floor(node.flexNode.getComputedPadding(Edge.Top))
    const paddingBottom = Math.floor(node.flexNode.getComputedPadding(Edge.Bottom))

    const innerX = x + borderLeft + paddingLeft
    const innerY = y + borderTop + paddingTop
    const innerWidth =
      width - borderLeft - borderRight - paddingLeft - paddingRight
    const innerHeight =
      height - borderTop - borderBottom - paddingTop - paddingBottom

    if (innerWidth > 0 && innerHeight > 0) {
      const rect: PaintRect = {
        x: innerX,
        y: innerY,
        width: innerWidth,
        height: innerHeight,
      }
      const painter: Painter = {
        set: (px, py, char, style) => {
          if (
            px >= rect.x &&
            py >= rect.y &&
            px < rect.x + rect.width &&
            py < rect.y + rect.height
          ) {
            screen.set(px, py, char, style)
          }
        },
        fillRect: (px, py, w, h, char = ' ', style) => {
          const left = Math.max(px, rect.x)
          const top = Math.max(py, rect.y)
          const right = Math.min(px + w, rect.x + rect.width)
          const bottom = Math.min(py + h, rect.y + rect.height)
          for (let row = top; row < bottom; row++) {
            for (let col = left; col < right; col++) {
              screen.set(col, row, char, style)
            }
          }
        },
        writeText: (px, py, text, style) => {
          if (py < rect.y || py >= rect.y + rect.height) {
            return
          }
          const chars = Array.from(text)
          for (let i = 0; i < chars.length; i++) {
            const cx = px + i
            if (cx < rect.x) {
              continue
            }
            if (cx >= rect.x + rect.width) {
              break
            }
            screen.set(cx, py, chars[i]!, style)
          }
        },
      }
      node.paint(painter, rect)
    }
  }

  for (const child of node.children) {
    drawLayoutNode(child, screen, hitRegions, x, y)
  }
}

function drawBorder(
  screen: ScreenBuffer,
  x: number,
  y: number,
  width: number,
  height: number,
  chars: BorderChars,
  style?: CellStyle,
): void {
  if (width < 2 || height < 2) {
    return
  }

  screen.set(x, y, chars.topLeft, style)
  screen.set(x + width - 1, y, chars.topRight, style)
  screen.set(x, y + height - 1, chars.bottomLeft, style)
  screen.set(x + width - 1, y + height - 1, chars.bottomRight, style)

  for (let col = 1; col < width - 1; col++) {
    screen.set(x + col, y, chars.horizontal, style)
    screen.set(x + col, y + height - 1, chars.horizontal, style)
  }

  for (let row = 1; row < height - 1; row++) {
    screen.set(x, y + row, chars.vertical, style)
    screen.set(x + width - 1, y + row, chars.vertical, style)
  }
}

function drawText(
  node: LayoutNode,
  screen: ScreenBuffer,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const borderLeft = Math.floor(node.flexNode.getComputedBorder(Edge.Left))
  const borderRight = Math.floor(node.flexNode.getComputedBorder(Edge.Right))
  const borderTop = Math.floor(node.flexNode.getComputedBorder(Edge.Top))
  const borderBottom = Math.floor(node.flexNode.getComputedBorder(Edge.Bottom))
  const paddingLeft = Math.floor(node.flexNode.getComputedPadding(Edge.Left))
  const paddingRight = Math.floor(node.flexNode.getComputedPadding(Edge.Right))
  const paddingTop = Math.floor(node.flexNode.getComputedPadding(Edge.Top))
  const paddingBottom = Math.floor(node.flexNode.getComputedPadding(Edge.Bottom))

  const innerX = x + borderLeft + paddingLeft
  const innerY = y + borderTop + paddingTop
  const innerWidth =
    width - borderLeft - borderRight - paddingLeft - paddingRight
  const innerHeight =
    height - borderTop - borderBottom - paddingTop - paddingBottom

  if (innerWidth <= 0 || innerHeight <= 0) {
    return
  }

  const lines = toLines(
    node.text ?? '',
    innerWidth,
    innerHeight,
    node.textOverflow ?? 'head',
  )
  const startY = alignVertical(
    node.textVerticalAlign ?? 'top',
    innerY,
    innerHeight,
    lines.length,
  )

  lines.forEach((line, index) => {
    const lineWidth = Array.from(line).length
    const startX = alignHorizontal(
      node.textAlign ?? 'left',
      innerX,
      innerWidth,
      lineWidth,
    )
    screen.writeText(startX, startY + index, line, node.appearance?.text)
  })
}

function toLines(
  text: string | string[],
  maxWidth: number,
  maxHeight: number,
  overflow: TextOverflow = 'head',
): string[] {
  const rawLines = Array.isArray(text) ? text : text.split('\n')
  const visible =
    overflow === 'tail' && rawLines.length > maxHeight
      ? rawLines.slice(rawLines.length - maxHeight)
      : rawLines.slice(0, maxHeight)
  return visible.map(line => truncateLine(line, maxWidth))
}

function truncateLine(line: string, maxWidth: number): string {
  const chars = Array.from(line)
  if (chars.length <= maxWidth) {
    return line
  }

  if (maxWidth <= 1) {
    return chars.slice(0, maxWidth).join('')
  }

  return `${chars.slice(0, maxWidth - 1).join('')}…`
}

function alignHorizontal(
  align: TextAlign,
  innerX: number,
  innerWidth: number,
  lineWidth: number,
): number {
  if (align === 'center') {
    return innerX + Math.max(0, Math.floor((innerWidth - lineWidth) / 2))
  }

  if (align === 'right') {
    return innerX + Math.max(0, innerWidth - lineWidth)
  }

  return innerX
}

function alignVertical(
  align: TextVerticalAlign,
  innerY: number,
  innerHeight: number,
  lineCount: number,
): number {
  if (align === 'middle') {
    return innerY + Math.max(0, Math.floor((innerHeight - lineCount) / 2))
  }

  if (align === 'bottom') {
    return innerY + Math.max(0, innerHeight - lineCount)
  }

  return innerY
}

function sameStyle(a?: CellStyle, b?: CellStyle): boolean {
  return a?.fg === b?.fg && a?.bg === b?.bg && a?.bold === b?.bold
}

function cloneStyle(style?: CellStyle): CellStyle | undefined {
  if (!style) {
    return undefined
  }

  return { ...style }
}

const RGB_FLAG = 0x01000000

function styleToAnsi(style?: CellStyle): string {
  if (!style) {
    return '\x1b[0m'
  }

  const parts = ['0']
  if (style.bold) {
    parts.push('1')
  }
  if (style.fg !== undefined) {
    parts.push(colorAnsi(38, style.fg))
  }
  if (style.bg !== undefined) {
    parts.push(colorAnsi(48, style.bg))
  }

  return `\x1b[${parts.join(';')}m`
}

function colorAnsi(base: 38 | 48, value: number): string {
  if (value >= RGB_FLAG) {
    const r = (value >> 16) & 0xff
    const g = (value >> 8) & 0xff
    const b = value & 0xff
    return `${base};2;${r};${g};${b}`
  }
  return `${base};5;${value}`
}
