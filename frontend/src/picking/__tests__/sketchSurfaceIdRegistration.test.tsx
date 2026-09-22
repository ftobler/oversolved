import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Topology } from '@/types/cad'
import { IdPipeline, SKETCH_SURFACE_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useSketchSurfaceIdRegistration } from '../useSketchSurfaceIdRegistration'

/**
 * The sketch-surface registration hook turns a topology area into a pickable
 * face in the collision-id buffer. The interesting behaviour is not that it
 * calls registerBody, but what it hands over (transformed triangle soup, face
 * query), what it refuses (degenerate loops), and that a failed registration
 * cannot escape the passive effect and unmount the viewport root.
 */

const square = [
  { kind: 'line', start: [0, 0], end: [4, 0] },
  { kind: 'line', start: [4, 0], end: [4, 4] },
  { kind: 'line', start: [4, 4], end: [0, 4] },
  { kind: 'line', start: [0, 4], end: [0, 0] },
]

const singleEdge = [{ kind: 'line', start: [0, 0], end: [1, 0] }]

const tri = [
  { kind: 'line', start: [0, 0], end: [2, 0] },
  { kind: 'line', start: [2, 0], end: [1, 2] },
  { kind: 'line', start: [1, 2], end: [0, 0] },
]

function topology(surfaces: unknown[]): Topology {
  return { vertices: {}, intersection_points: {}, edges: [], surfaces } as unknown as Topology
}

function livePipeline(): IdPipeline {
  const p = new IdPipeline({ width: 64, height: 64 })
  setLivePipeline(p)
  return p
}

afterEach(() => {
  setLivePipeline(null)
  vi.restoreAllMocks()
})

describe('useSketchSurfaceIdRegistration', () => {
  it('registers one face body per buildable area, stamped with the surface query', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, query: '?1;@a' }]),
    }))

    expect(spy).toHaveBeenCalledTimes(1)
    const body = spy.mock.calls[0][0]
    expect(body.bodyKey).toBe('S1/?1;@a')
    expect(body.faceQueries).toEqual(['?1;@a'])
    // A square triangulates to at least two triangles; every one maps back to
    // the single face this body represents.
    expect(body.positions.length % 9).toBe(0)
    expect(body.positions.length / 9).toBeGreaterThanOrEqual(2)
    expect(Array.from(body.triangleToFace)).toEqual(
      Array.from({ length: body.positions.length / 9 }, () => 0),
    )
    expect(p.registry.lookupKey(SKETCH_SURFACE_LAYER_NAME, '?1;@a')).toBeDefined()
    p.dispose()
  })

  it('applies the plane transform to the registered triangles', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: tri, query: '?2;@b' }]),
      planeTransform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [10, 20, 30] },
    }))

    const positions = spy.mock.calls[0][0].positions
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeGreaterThanOrEqual(10)
      expect(positions[i + 1]).toBeGreaterThanOrEqual(20)
      expect(positions[i + 2]).toBeCloseTo(30, 5)
    }
    p.dispose()
  })

  it('tessellates holes so a holed area has more triangles than the outer loop alone', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    const hole = [
      { kind: 'line', start: [1, 1], end: [3, 1] },
      { kind: 'line', start: [3, 1], end: [2, 3] },
      { kind: 'line', start: [2, 3], end: [1, 1] },
    ]
    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, holes: [hole], query: '?3;@donut' }]),
    }))

    const withHole = spy.mock.calls[0][0].positions.length
    spy.mockClear()

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S2',
      topology: topology([{ boundary: square, query: '?4;@solid' }]),
    }))
    const solid = spy.mock.calls[0][0].positions.length
    expect(withHole).toBeGreaterThan(solid)
    p.dispose()
  })

  it('skips a degenerate area whose boundary cannot form a polygon', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: singleEdge, query: '?bad' }]),
    }))

    expect(spy).not.toHaveBeenCalled()
    p.dispose()
  })

  it('unregisters its bodies and marks the pipeline dirty again on unmount', () => {
    const p = livePipeline()
    const dirty = vi.spyOn(p, 'markDirty')
    const { unmount } = renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, query: '?1;@a' }]),
    }))
    expect(dirty).toHaveBeenCalledTimes(1)

    unmount()

    expect(p.registry.lookupKey(SKETCH_SURFACE_LAYER_NAME, '?1;@a')).toBeUndefined()
    expect(dirty).toHaveBeenCalledTimes(2)
    p.dispose()
  })

  it('does nothing when disabled, without topology, or without any surfaces', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1', enabled: false, topology: topology([{ boundary: square, query: '?a' }]),
    }))
    renderHook(() => useSketchSurfaceIdRegistration({ featureId: 'S1', topology: undefined }))
    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1', topology: topology([]),
    }))

    expect(spy).not.toHaveBeenCalled()
    p.dispose()
  })

  it('does not register while no pipeline is live', () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(null)
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    expect(() => renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, query: '?a' }]),
    }))).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
    p.dispose()
  })

  it('a registerBody throw is swallowed and does not unmount the caller', () => {
    const p = livePipeline()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(p.sketchSurfaceLayer, 'registerBody').mockImplementation(() => {
      throw new Error('IdRegistry: exhausted 24-bit ID space')
    })

    expect(() => renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, query: '?a' }]),
    }))).not.toThrow()

    expect(warn).toHaveBeenCalled()
    p.dispose()
  })

  it('registers even an area stamped unbuildable, so a dead area stays clickable', () => {
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, query: '?nope', buildable: false, reason: 'self intersects' }]),
    }))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].faceQueries).toEqual(['?nope'])
    p.dispose()
  })

  it('ignores a hole loop too short to tessellate instead of failing the surface', () => {
    // A one-edge "hole" yields two points, not a polygon. It is dropped like a
    // degenerate boundary, and the outer area still registers.
    const p = livePipeline()
    const spy = vi.spyOn(p.sketchSurfaceLayer, 'registerBody')

    renderHook(() => useSketchSurfaceIdRegistration({
      featureId: 'S1',
      topology: topology([{ boundary: square, holes: [singleEdge], query: '?5;@hole' }]),
    }))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].faceQueries).toEqual(['?5;@hole'])
    p.dispose()
  })
})
