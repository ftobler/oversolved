import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { Sketch, Topology } from '@/types/cad'

/**
 * Registration-level pin of the inactive-sketch pick rule: while sketch B is
 * being edited, sketch A's entity and vertex ids exist in the id buffer only
 * under a tool that declares `picksInactiveSketches` (project). Disarming the
 * tool must put the ids back, so plain selection inside a sketch stays inert.
 *
 * The child renderers are stubbed: the subject is the registration hook's
 * `enabled` gate, not the three.js drawing.
 */

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {} }),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
}))

vi.mock('@/components/Geometry3D/VertexDots', () => ({ VertexDot: () => null, VertexHighlight: () => null }))
vi.mock('@/components/Geometry3D/EntityLines', () => ({ EntityLines: () => null }))
vi.mock('@/components/Geometry3D/Surfaces', () => ({ TopologySurfaces: () => null }))
vi.mock('@/components/Geometry3D/Constraints', () => ({ ConstraintOverlays: () => null }))
vi.mock('@/components/Geometry3D/Dragging', () => ({ DragPlane: () => null, DragSnapIndicator: () => null }))
vi.mock('@/components/Geometry3D/InferredContactMarkers', () => ({ InferredContactMarkers: () => null }))
vi.mock('@/components/Geometry3D/Drawing', () => ({ DrawPreview: () => null, DrawPlane: () => null }))
vi.mock('@/components/Geometry3D/dimensions/Preview', () => ({ DimensionPreview: () => null }))
vi.mock('@/hooks/useWasmDragSolve', () => ({
  useWasmDragSolve: () => ({ sketch: null, engaged: false }),
}))
vi.mock('@/kernel/features/sketch', () => ({
  resolvedKindsOfSketch: () => ({}),
  setSketchTopology: () => {},
}))

// Inferred contacts are a fixable stand-in: the point is whether the hook asks
// for them at all for an inactive sketch, not how they are derived.
const inferred = vi.hoisted(() => ({ candidates: [] as { id: string; position: number[] }[] }))
vi.mock('@/utils/geometry/snapDetection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/geometry/snapDetection')>()
  return { ...actual, inferredContactCandidates: () => inferred.candidates }
})

import Geometry3D from '@/components/Geometry3D'
import { IdPipeline, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

const sketchA: Sketch = {
  L1: { start: [0, 0], end: [10, 0] },
}

// A buildable square area, so the surface assertion below is not vacuous: with
// the gate open the area layer registers this body.
const TOPOLOGY = {
  vertices: {},
  intersection_points: {},
  edges: [],
  surfaces: [{
    query: '?1;@a',
    boundary: [
      { kind: 'line', start: [0, 0], end: [4, 0] },
      { kind: 'line', start: [4, 0], end: [4, 4] },
      { kind: 'line', start: [4, 4], end: [0, 4] },
      { kind: 'line', start: [0, 4], end: [0, 0] },
    ],
  }],
} as unknown as Topology

let pipeline: IdPipeline

function renderInactiveSketchA(extra: { visible?: boolean } = {}) {
  return render(
    <Geometry3D
      featureId="A"
      solved={sketchA}
      topology={TOPOLOGY}
      activeFeatureId="B"
      visible={extra.visible ?? true}
      suppressed={false}
    />,
  )
}

function aIsRegistered(): boolean {
  return pipeline.registry.lookupKey(SKETCH_ENTITY_LAYER_NAME, 'entity:A:L1') !== undefined
}

beforeEach(() => {
  pipeline = new IdPipeline({ width: 100, height: 100 })
  setLivePipeline(pipeline)
  useSketchEditorStore.setState({ activeTool: null, drag: null, dragCommitted: false })
  inferred.candidates = []
})

afterEach(() => {
  cleanup()
  setLivePipeline(null)
  pipeline.dispose()
  useSketchEditorStore.setState({ activeTool: null })
})

describe('inactive sketch pick registration under the project tool', () => {
  it('registers sketch A lines and vertices while sketch B is edited and project is armed', () => {
    useSketchEditorStore.setState({ activeTool: 'project' })
    renderInactiveSketchA()

    expect(aIsRegistered()).toBe(true)
    expect(pipeline.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:A:L1:start')).toBeDefined()
    expect(pipeline.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:A:L1:end')).toBeDefined()
    // The area layer stays out: the project preset excludes sketchSurface, so
    // the only ids a foreign sketch offers are its curves and points. The
    // topology above is buildable, so zero means the gate, not an empty area.
    expect(pipeline.sketchSurfaceLayer.partCount()).toBe(0)
    expect(pipeline.sketchEntityLayer.partCount()).toBe(1)
  })

  it('still registers the edited sketch area under project', () => {
    // Control for the zero above: the same topology on the sketch being edited
    // does register, so an inactive-sketch area is withheld on purpose.
    useSketchEditorStore.setState({ activeTool: 'project' })
    render(
      <Geometry3D
        featureId="A"
        solved={sketchA}
        topology={TOPOLOGY}
        activeFeatureId="A"
        visible
        suppressed={false}
      />,
    )

    expect(pipeline.sketchSurfaceLayer.partCount()).toBe(1)
  })

  it('registers them when the tool is armed after mount, and drops them on disarm', () => {
    // The real user flow: the sketch is already on screen, then Project is
    // pressed. The subscription, not a remount, must turn the ids on and off.
    renderInactiveSketchA()
    expect(pipeline.sketchEntityLayer.partCount()).toBe(0)

    act(() => { useSketchEditorStore.setState({ activeTool: 'project' }) })
    expect(aIsRegistered()).toBe(true)
    expect(pipeline.sketchEntityLayer.partCount()).toBe(1)

    act(() => { useSketchEditorStore.setState({ activeTool: null }) })
    expect(aIsRegistered()).toBe(false)
    expect(pipeline.sketchEntityLayer.partCount()).toBe(0)
    expect(pipeline.sketchVertexLayer.partCount()).toBe(0)
  })

  it('keeps an inactive sketch inert with no tool armed (plain selection)', () => {
    renderInactiveSketchA()
    expect(pipeline.sketchEntityLayer.partCount()).toBe(0)
    expect(pipeline.sketchVertexLayer.partCount()).toBe(0)
  })

  it('keeps an inactive sketch inert under a drawing tool', () => {
    useSketchEditorStore.setState({ activeTool: 'line' })
    renderInactiveSketchA()
    expect(pipeline.sketchEntityLayer.partCount()).toBe(0)
  })

  it('never registers a hidden inactive sketch, even with project armed', () => {
    useSketchEditorStore.setState({ activeTool: 'project' })
    renderInactiveSketchA({ visible: false })
    expect(pipeline.sketchEntityLayer.partCount()).toBe(0)
    expect(pipeline.sketchVertexLayer.partCount()).toBe(0)
  })

  it('does not register an inactive sketch inferred-contact handle', () => {
    // A dock:/isect: handle is drawn only by the edited sketch's markers, so
    // registering one for an inactive sketch would offer an invisible pick that
    // can eat the project click meant for the line under it.
    inferred.candidates = [{ id: 'dock:A:e1', position: [5, 0] }]
    useSketchEditorStore.setState({ activeTool: 'project' })
    renderInactiveSketchA()

    expect(aIsRegistered()).toBe(true)
    expect(pipeline.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'dock:A:e1')).toBeUndefined()
  })
})
