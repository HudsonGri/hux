import type { HitRegion } from './runtime.js'
import { pointerShapeSupported } from './terminal-caps.js'
import type { AppState } from './wm.js'

export type PointerShapeDeps = {
  getState: () => AppState
  findRegion: (x: number, y: number) => HitRegion | undefined
  write: (seq: string) => void
}

let deps: PointerShapeDeps | null = null
let currentShape = 'default'

function d(): PointerShapeDeps {
  if (!deps) throw new Error('pointer-shape not initialized')
  return deps
}

export function initPointerShape(d: PointerShapeDeps): void {
  deps = d
}

function shapeForCursor(x: number, y: number): string {
  const { getState, findRegion } = d()
  const state = getState()
  if (state.drag.kind === 'resize') {
    return state.drag.orientation === 'row' ? 'ew-resize' : 'ns-resize'
  }
  if (state.drag.kind === 'pane' || state.drag.kind === 'tab') {
    return 'grabbing'
  }
  const region = findRegion(x, y)
  if (!region) return 'default'
  if (region.id.startsWith('split-handle:')) {
    return region.width === 1 ? 'ew-resize' : 'ns-resize'
  }
  if (region.id.startsWith('pane-header:')) {
    return 'grab'
  }
  if (region.id.startsWith('tab:') || region.id === 'tab-new') {
    return 'pointer'
  }
  return 'default'
}

export function updatePointerShape(x: number, y: number): void {
  if (!pointerShapeSupported) return
  const shape = shapeForCursor(x, y)
  if (shape === currentShape) return
  currentShape = shape
  d().write(`\x1b]22;${shape}\x1b\\`)
}
