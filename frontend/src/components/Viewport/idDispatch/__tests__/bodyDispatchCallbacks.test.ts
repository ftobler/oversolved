import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerBodyCallbacks,
  findEdgeKindForQuery,
  findBodyForFaceQuery,
  findBodyFaceByPickKey,
  findFaceBoundaryEdges,
  clearAllBodyHover,
  resetBodyCallbacksForTest,
  type BodyDispatchCallbacks,
} from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { brepFaceAdapter } from '@/components/Viewport/idDispatch/brepAdapters'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Mesh3D } from '@/types/cad'

// The id-buffer dispatcher resolves a picked face/edge query back to the owning
// Body3D through this module-level registry. The registry is process-global, so
// every test resets it first; the store is exercised directly (no mocks) per the
// project's "Zustand works directly" rule.

function makeMesh(over: Partial<Mesh3D> = {}): Mesh3D {
  return {
    vertices: new Float32Array([0, 0, 0]),
    faces: new Uint32Array([0, 0, 0]),
    face_queries: ['faceQ0', 'faceQ1'],
    ...over,
  }
}

function makeCallbacks(over: Partial<BodyDispatchCallbacks> = {}): BodyDispatchCallbacks {
  return {
    featureId: 'extrude1',
    bodyId: 'body_1',
    mesh: makeMesh(),
    edgeQueries: ['edgeQ0', 'edgeQ1'],
    edgeKinds: ['line', 'arc'],
    vertexQueries: ['vtxQ0'],
    updateFaceGeometryForIndex: vi.fn(),
    clearFaceGeometry: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  resetBodyCallbacksForTest()
  const s = useSketchEditorStore.getState()
  s.setHoveredSelectionId(null)
  s.setHoveredPickKey(null)
  s.setHoveredFaceGeometry(null, null)
})

describe('registerBodyCallbacks', () => {
  it('registers the body so its queries become resolvable', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    expect(findBodyForFaceQuery('faceQ1')?.index).toBe(1)
    expect(findEdgeKindForQuery('edgeQ1')).toBe('arc')
  })

  it('returns an unregister fn that removes the body', () => {
    const unregister = registerBodyCallbacks('b1', makeCallbacks())
    unregister()
    expect(findBodyForFaceQuery('faceQ0')).toBeNull()
    expect(findEdgeKindForQuery('edgeQ0')).toBeUndefined()
  })

  it('unregister clears hover state when this body owns the hovered query', () => {
    const cb = makeCallbacks()
    const unregister = registerBodyCallbacks('b1', cb)
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId('faceQ0')
    s.setHoveredFaceGeometry([0, 0, 1], [1, 2, 3])

    unregister()

    const after = useSketchEditorStore.getState()
    expect(after.hoveredSelectionId).toBeNull()
    expect(after.hoveredPickKey).toBeNull()
    expect(after.hoveredFaceNormal).toBeNull()
    expect(after.hoveredFaceCenter).toBeNull()
  })

  it('unregister nulls hoveredPickKey alongside hoveredSelectionId', () => {
    // hoveredPickKey rides with hoveredSelectionId to isolate one of several
    // primitives that share a query; when the owning body goes away, both halves
    // of the pair must go or hoverActiveFrom's pickKeys half keeps a stale key.
    const unregister = registerBodyCallbacks('b1', makeCallbacks())
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId('faceQ0')
    s.setHoveredPickKey('body_1#1')

    unregister()

    const after = useSketchEditorStore.getState()
    expect(after.hoveredSelectionId).toBeNull()
    expect(after.hoveredPickKey).toBeNull()
  })

  it('unregister leaves hover untouched when another body owns the hover', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId('someOtherBodyQuery')

    const unregister = registerBodyCallbacks('b2', makeCallbacks({
      mesh: makeMesh({ face_queries: ['otherFace'] }),
      edgeQueries: ['otherEdge'],
      vertexQueries: ['otherVtx'],
    }))
    unregister()  // b2 does not own 'someOtherBodyQuery'

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('someOtherBodyQuery')
  })

  // The ownership check is `face_queries?.includes(h) ?? edgeQueries?.includes(h)
  // ?? vertexQueries?.includes(h) ?? false`. Because `??` only falls through on a
  // nullish left side, a present `face_queries` (even when it does not contain the
  // hovered id) decides the result, and the edge/vertex arms are reached only when
  // the earlier arrays are absent.
  // L4: `??` stopped at the first present array, so a body with face_queries
  // (almost every real body) could not recognise its own hovered edge/vertex
  // and its teardown stranded the hover. ownsQuery now checks all three maps.
  it('unregister clears a hovered edge query even when face_queries is present', () => {
    const unregister = registerBodyCallbacks('b1', makeCallbacks())  // all three arrays present
    useSketchEditorStore.getState().setHoveredSelectionId('edgeQ0')
    unregister()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('unregister clears a hovered vertex query even when face and edge arrays are present', () => {
    const unregister = registerBodyCallbacks('b1', makeCallbacks())  // all three arrays present
    useSketchEditorStore.getState().setHoveredSelectionId('vtxQ0')
    unregister()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('unregister clears a hovered edge query when face_queries is absent', () => {
    const cb = makeCallbacks({ mesh: makeMesh({ face_queries: undefined }) })
    const unregister = registerBodyCallbacks('b1', cb)
    useSketchEditorStore.getState().setHoveredSelectionId('edgeQ0')
    unregister()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('unregister clears a hovered vertex query when face and edge arrays are absent', () => {
    const cb = makeCallbacks({ mesh: makeMesh({ face_queries: undefined }), edgeQueries: undefined })
    const unregister = registerBodyCallbacks('b1', cb)
    useSketchEditorStore.getState().setHoveredSelectionId('vtxQ0')
    unregister()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('a superseded unregister is a no-op (does not delete the live registration)', () => {
    const first = makeCallbacks()
    const unregisterFirst = registerBodyCallbacks('b1', first)
    // Same key re-registered with a different callback object (e.g. a re-render).
    registerBodyCallbacks('b1', makeCallbacks({ edgeKinds: ['circle', 'circle'] }))
    // The stale unregister must not evict the current registration.
    unregisterFirst()
    expect(findEdgeKindForQuery('edgeQ0')).toBe('circle')
  })
})

describe('findEdgeKindForQuery', () => {
  it('returns undefined for an unknown query', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    expect(findEdgeKindForQuery('nope')).toBeUndefined()
  })

  it('returns undefined when the body has no edgeKinds parallel array', () => {
    registerBodyCallbacks('b1', makeCallbacks({ edgeKinds: undefined }))
    expect(findEdgeKindForQuery('edgeQ0')).toBeUndefined()
  })

  it('searches across multiple registered bodies', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    registerBodyCallbacks('b2', makeCallbacks({
      edgeQueries: ['farEdge'],
      edgeKinds: ['spline'],
    }))
    expect(findEdgeKindForQuery('farEdge')).toBe('spline')
  })
})

describe('findBodyForFaceQuery', () => {
  it('returns the owning body and the face index', () => {
    const cb = makeCallbacks()
    registerBodyCallbacks('b1', cb)
    const hit = findBodyForFaceQuery('faceQ0')
    expect(hit?.body).toBe(cb)
    expect(hit?.index).toBe(0)
  })

  it('returns null when no body owns the query', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    expect(findBodyForFaceQuery('ghost')).toBeNull()
  })

  it('findBodyFaceByPickKey resolves a per-primitive pickKey to its owner and index', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    const found = findBodyFaceByPickKey('b1#face#1')
    expect(found?.bodyKey).toBe('b1')
    expect(found?.index).toBe(1)
  })

  it('findBodyFaceByPickKey returns null when no body matches the key', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    expect(findBodyFaceByPickKey('nope#face#0')).toBeNull()
    expect(findBodyFaceByPickKey('b1#face#99')).toBeNull()
  })

  it('findBodyFaceByPickKey returns null when a body mesh has no face_queries', () => {
    registerBodyCallbacks('b1', makeCallbacks({ mesh: makeMesh({ face_queries: undefined }) }))
    expect(findBodyFaceByPickKey('b1#face#0')).toBeNull()
  })

  it('returns null when a body mesh has no face_queries', () => {
    registerBodyCallbacks('b1', makeCallbacks({ mesh: makeMesh({ face_queries: undefined }) }))
    expect(findBodyForFaceQuery('faceQ0')).toBeNull()
  })
})

describe('findFaceBoundaryEdges', () => {
  it('maps each boundary edge to its source and resolved kind', () => {
    registerBodyCallbacks('b1', makeCallbacks({
      mesh: makeMesh({
        face_queries: ['faceQ0'],
        face_edge_queries: [['edgeQ1', 'edgeQ0']],
      }),
    }))
    expect(findFaceBoundaryEdges('faceQ0')).toEqual([
      { source: 'edgeQ1', kind: 'arc' },
      { source: 'edgeQ0', kind: 'line' },
    ])
  })

  it("falls back to 'line' when an edge source is not a registered edge", () => {
    registerBodyCallbacks('b1', makeCallbacks({
      mesh: makeMesh({
        face_queries: ['faceQ0'],
        face_edge_queries: [['unregisteredEdge']],
      }),
    }))
    expect(findFaceBoundaryEdges('faceQ0')).toEqual([{ source: 'unregisteredEdge', kind: 'line' }])
  })

  it('returns null when the face carries no boundary edge queries', () => {
    registerBodyCallbacks('b1', makeCallbacks({
      mesh: makeMesh({ face_queries: ['faceQ0'], face_edge_queries: [[]] }),
    }))
    expect(findFaceBoundaryEdges('faceQ0')).toBeNull()
  })

  it('returns null when the face_edge_queries entry is missing', () => {
    registerBodyCallbacks('b1', makeCallbacks({
      mesh: makeMesh({ face_queries: ['faceQ0'] }),  // no face_edge_queries
    }))
    expect(findFaceBoundaryEdges('faceQ0')).toBeNull()
  })

  it('returns null when the query matches no registered face', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    expect(findFaceBoundaryEdges('ghostFace')).toBeNull()
  })
})

// These lookups run on every pointer move. They used to scan every registered
// body and indexOf its whole query array (and findFaceBoundaryEdges compounded
// that with a scan per boundary edge), so hover cost grew with the model.
// Registration now builds reverse indexes; the tests below pin the upkeep those
// indexes need in order to stay honest, which the stateless scan got for free.
describe('reverse index upkeep', () => {
  it('resolves a query in a heavy model, whichever body owns it', () => {
    const BODIES = 300
    const FACES = 100
    for (let b = 0; b < BODIES; b++) {
      registerBodyCallbacks(`body${b}`, makeCallbacks({
        mesh: makeMesh({ face_queries: Array.from({ length: FACES }, (_, i) => `face-${b}-${i}`) }),
        edgeQueries: Array.from({ length: FACES }, (_, i) => `edge-${b}-${i}`),
        edgeKinds: Array.from({ length: FACES }, () => 'circle'),
      }))
    }
    // Last face of the last body: the entry the full scan reached last.
    expect(findBodyForFaceQuery(`face-${BODIES - 1}-${FACES - 1}`)?.index).toBe(FACES - 1)
    expect(findBodyForFaceQuery('face-0-0')?.index).toBe(0)
    expect(findEdgeKindForQuery(`edge-${BODIES - 1}-7`)).toBe('circle')
    expect(findBodyForFaceQuery('face-300-0')).toBeNull()
  })

  it('stops resolving a query once its body unregisters', () => {
    const unregister = registerBodyCallbacks('b1', makeCallbacks())
    registerBodyCallbacks('b2', makeCallbacks({
      mesh: makeMesh({ face_queries: ['otherFace'] }),
      edgeQueries: ['otherEdge'],
      edgeKinds: ['circle'],
    }))
    unregister()
    expect(findBodyForFaceQuery('faceQ0')).toBeNull()
    expect(findEdgeKindForQuery('edgeQ0')).toBeUndefined()
    // The surviving body must be untouched by the other's eviction.
    expect(findBodyForFaceQuery('otherFace')?.index).toBe(0)
    expect(findEdgeKindForQuery('otherEdge')).toBe('circle')
  })

  it('re-registering a body under the same key retires its old queries', () => {
    registerBodyCallbacks('b1', makeCallbacks())
    registerBodyCallbacks('b1', makeCallbacks({
      mesh: makeMesh({ face_queries: ['reworkedFace'] }),
      edgeQueries: ['reworkedEdge'],
      edgeKinds: ['spline'],
    }))
    expect(findBodyForFaceQuery('faceQ0')).toBeNull()
    expect(findEdgeKindForQuery('edgeQ0')).toBeUndefined()
    expect(findBodyForFaceQuery('reworkedFace')?.index).toBe(0)
    expect(findEdgeKindForQuery('reworkedEdge')).toBe('spline')
  })

  it('when two bodies share a query the first registered one answers', () => {
    const first = makeCallbacks()
    registerBodyCallbacks('b1', first)
    const unregisterSecond = registerBodyCallbacks('b2', makeCallbacks())
    expect(findBodyForFaceQuery('faceQ0')?.body).toBe(first)
    // ...and dropping the loser leaves the winner resolvable.
    unregisterSecond()
    expect(findBodyForFaceQuery('faceQ0')?.body).toBe(first)
  })
})

describe('clearAllBodyHover', () => {
  // L5b: only one body's face geometry is ever live (one pair of store fields),
  // so the teardown targets that body instead of walking every registered one.
  it('clears only the body that last computed face geometry', () => {
    const a = makeCallbacks({ mesh: makeMesh({ face_queries: ['fa'] }) })
    const b = makeCallbacks({ mesh: makeMesh({ face_queries: ['fb'] }) })
    registerBodyCallbacks('feat/a', a)
    registerBodyCallbacks('feat/b', b)

    brepFaceAdapter.onHover('fa', 'feat/a#face#0')  // body a becomes the owner
    clearAllBodyHover()

    expect(a.clearFaceGeometry).toHaveBeenCalledTimes(1)
    expect(b.clearFaceGeometry).not.toHaveBeenCalled()
  })

  it('does not throw after the owning body has unregistered', () => {
    const a = makeCallbacks({ mesh: makeMesh({ face_queries: ['fa'] }) })
    const unregister = registerBodyCallbacks('feat/a', a)
    brepFaceAdapter.onHover('fa', 'feat/a#face#0')
    unregister()
    expect(() => clearAllBodyHover()).not.toThrow()
  })

  it('is a no-op with no registered bodies', () => {
    expect(() => clearAllBodyHover()).not.toThrow()
  })
})
