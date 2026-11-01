// The drag tool context is assembled from one builder: the activation frame, the
// commit frame and the id-buffer pointer-down dispatch each spelled the same
// literal out separately before it existed.
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { buildDragToolContext, type DragContextSource } from '@/tools/DragTool'
import type { DragState, DragPendingState } from '@/stores/sketchEditorStore'

const SRC = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full)
  }
  return out
}

function rel(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/')
}

const isTestFile = (name: string) => name.includes('__tests__') || /\.test\.tsx?$/.test(name)

const vertexDrag: DragState = {
  type: 'vertex', vertexId: 'vertex:S1:lineA:start', featureId: 'S1',
  entityId: 'lineA', vertexKey: 'start', startWorld: [0, 0], currentWorld: [1, 1],
  startClient: [10, 10],
}

function source(over: Partial<DragContextSource> = {}): DragContextSource {
  return {
    normalSelection: new Set(['entity:S1:lineB']),
    hoveredSelectionId: 'entity:S1:lineA',
    isPointerDown: true,
    activeFeatureId: 'S1',
    hoveredVertexId: 'vertex:S1:lineA:start',
    hoveredVertexPosition: [0, 0],
    hoveredSnapKind: 'vertex',
    drag: vertexDrag,
    dragPending: null,
    dragSnap: null,
    dragStartClient: [10, 10],
    ...over,
  }
}

const handlers = () => ({
  onMutation: vi.fn(),
  setDrag: vi.fn(),
  setDragPending: vi.fn(),
  setDragSnap: vi.fn(),
})

describe('buildDragToolContext', () => {
  it('carries the store fields through', () => {
    const h = handlers()
    const ctx = buildDragToolContext(source(), h)
    expect(ctx.normalSelection).toEqual(new Set(['entity:S1:lineB']))
    expect(ctx.hoveredSelectionId).toBe('entity:S1:lineA')
    expect(ctx.isPointerDown).toBe(true)
    expect(ctx.activeFeatureId).toBe('S1')
    expect(ctx.hoveredVertexId).toBe('vertex:S1:lineA:start')
    expect(ctx.hoveredVertexPosition).toEqual([0, 0])
    expect(ctx.hoveredSnapKind).toBe('vertex')
    expect(ctx.drag).toBe(vertexDrag)
    expect(ctx.dragSnap).toBeNull()
    expect(ctx.startClient).toEqual([10, 10])
    expect(ctx.onMutation).toBe(h.onMutation)
    expect(ctx.setDrag).toBe(h.setDrag)
    expect(ctx.setDragPending).toBe(h.setDragPending)
    expect(ctx.setDragSnap).toBe(h.setDragSnap)
  })

  it('lets the activation frame override the hover with the press point', () => {
    const ctx = buildDragToolContext(source(), handlers(), {
      hoveredVertexId: 'vertex:S1:lineA:start',
      hoveredVertexPosition: [4, 0],
      drag: null,
    })
    expect(ctx.hoveredVertexPosition).toEqual([4, 0])
    expect(ctx.drag).toBeNull()
  })

  it('narrows a dimension-label drag out of the tool context', () => {
    // A dim-label drag is the DragPlane's own gesture; the drag tool must never
    // see it as a vertex/edge drag.
    const dim: DragState = {
      type: 'dim_label', constraintId: 'c1', featureId: 'S1',
      anchorWorld: [0, 0], startWorld: [0, 0], currentWorld: [1, 1],
    }
    expect(buildDragToolContext(source({ drag: dim }), handlers()).drag).toBeNull()
  })

  it('narrows a feature-handle pending drag out of the tool context', () => {
    const pending: DragPendingState = {
      type: 'feature_handle', featureId: 'F1', field: 'distance',
      startValue: 1, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], unitScale: 1, min: 0,
    }
    expect(buildDragToolContext(source({ dragPending: pending }), handlers()).dragPending).toBeNull()
  })

  it('the mode stack is a no-op: the store owns it', () => {
    const ctx = buildDragToolContext(source(), handlers())
    expect(() => { ctx.pushMode('drag'); ctx.popMode('drag') }).not.toThrow()
  })

  it('lets the pointer-down dispatch override the store reads it just wrote', () => {
    // The id-buffer dispatch resolves the pick itself and writes isPointerDown
    // and dragStartClient before building; the snapshot it passes predates both.
    const stale = source({ hoveredSelectionId: null, isPointerDown: false, dragStartClient: null })
    const ctx = buildDragToolContext(stale, handlers(), {
      hoveredSelectionId: 'vertex:S1:lineA:start',
      isPointerDown: true,
      hoveredVertexId: 'vertex:S1:lineA:start',
      hoveredVertexPosition: null,
      startClient: [7, 9],
    })
    expect(ctx.hoveredSelectionId).toBe('vertex:S1:lineA:start')
    expect(ctx.isPointerDown).toBe(true)
    expect(ctx.startClient).toEqual([7, 9])
    expect(ctx.hoveredVertexPosition).toBeNull()
  })
})

describe('one builder', () => {
  it('no module outside it names the drag context type', () => {
    // The hand-built literal was written as `const ctx: DragToolContext = {...}`;
    // banning the type name outside its own module keeps a second copy from
    // reappearing without a reviewer noticing.
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const name = rel(file)
      if (isTestFile(name) || name === 'tools/DragTool.ts') continue
      if (/\bDragToolContext\b/.test(readFileSync(file, 'utf8'))) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('only the builder and the stores spell the context fields together', () => {
    // A literal has to name the drag snap slot beside the setter that writes it.
    // The stores are the source of both; every consumer must go through the
    // builder instead.
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const name = rel(file)
      if (isTestFile(name) || name === 'tools/DragTool.ts' || name.startsWith('stores/')) continue
      const src = readFileSync(file, 'utf8')
      if (/setDragPending:/.test(src) && /dragSnap:/.test(src)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('the known producers all go through the builder', () => {
    const producers: Record<string, number> = {}
    for (const file of sourceFiles(SRC)) {
      const name = rel(file)
      // The module that defines the builder is not a call site.
      if (isTestFile(name) || name === 'tools/DragTool.ts') continue
      const calls = readFileSync(file, 'utf8').match(/buildDragToolContext\(/g)
      if (calls) producers[name] = calls.length
    }
    expect(producers).toEqual({
      'components/Geometry3D/Dragging.tsx': 2,
      'components/Viewport/idDispatch/dispatchSketchClick.ts': 1,
    })
  })
})
