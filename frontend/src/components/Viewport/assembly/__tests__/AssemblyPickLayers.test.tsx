// During a settle the drawn pick geometry is re-derived every tick. Only the
// bodies that actually moved get new objects, so the registration must diff on
// object identity: re-registering the whole scene every frame would rebuild
// every id buffer and dirty the pick pass for a drag that moved one part.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { IdPipelineContext, type IdPipeline } from '@/picking'
import AssemblyPickLayers from '@/components/Viewport/assembly/AssemblyPickLayers'
import type { AssemblyPickPart } from '@/utils/assemblyPick'

function part(handle: string): AssemblyPickPart {
  return {
    handle,
    partKey: `${handle}:body_0`,
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: [`${handle}:body_0:face0`],
    },
    edges: null,
    vertices: null,
    faceBoundaries: null,
  }
}

function fullPart(handle: string): AssemblyPickPart {
  return {
    ...part(handle),
    edges: {
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: [`${handle}:edge0`],
    },
    vertices: { vertices: [[0, 0, 0]], vertexQueries: [`${handle}:vtx0`] },
  }
}

function stubPipeline(throwOnEdgeFor?: string) {
  const registered: string[] = []
  const unregistered: string[] = []
  // What the pipeline currently holds, so a test can assert no stale layer
  // survives a partial registration.
  const live = new Set<string>()
  let dirty = 0
  const layer = (kind: string) => ({
    registerPart: vi.fn((reg: { partKey: string }) => {
      if (kind === 'edge' && reg.partKey === throwOnEdgeFor) throw new Error('bad edge payload')
      registered.push(`${kind}:${reg.partKey}`)
      live.add(`${kind}:${reg.partKey}`)
    }),
    unregisterPart: vi.fn((partKey: string) => {
      unregistered.push(`${kind}:${partKey}`)
      live.delete(`${kind}:${partKey}`)
    }),
  })
  const pipeline = {
    faceLayer: layer('face'),
    edgeLayer: layer('edge'),
    vertexLayer: layer('vertex'),
    markDirty: vi.fn(() => { dirty++ }),
  } as unknown as IdPipeline
  return {
    pipeline,
    registered,
    unregistered,
    live,
    dirty: () => dirty,
    reset: () => { registered.length = 0; unregistered.length = 0; dirty = 0 },
  }
}

function tree(pipeline: IdPipeline, parts: AssemblyPickPart[], layers: { showFaces?: boolean; showEdges?: boolean } = {}) {
  return (
    <IdPipelineContext.Provider value={pipeline}>
      <AssemblyPickLayers parts={parts} {...layers} />
    </IdPipelineContext.Provider>
  )
}

describe('AssemblyPickLayers hidden seams', () => {
  function seamPart(handle: string): AssemblyPickPart {
    return {
      ...part(handle),
      edges: {
        segmentPositions: new Float32Array([
          0, 0, 0, 1, 0, 0,
          1, 0, 0, 1, 0, 1,
          2, 0, 0, 3, 0, 0,
        ]),
        segmentToEdge: new Uint32Array([0, 1, 2]),
        edgeQueries: [`${handle}:edge0`, `${handle}:edge1`, `${handle}:edge2`],
      },
      vertices: {
        vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
        vertexQueries: [`${handle}:vtx0`, `${handle}:vtx1`, `${handle}:vtx2`],
        slotIndices: [0, 1, 2],
      },
      hiddenEdges: [1],
      hiddenVertices: [1],
    }
  }

  it('skips the seam segment and the hidden vertex at registration, keeping their neighbours', () => {
    const { pipeline } = stubPipeline()
    render(tree(pipeline, [seamPart('p1')]))

    const edgeReg = vi.mocked(pipeline.edgeLayer.registerPart).mock.calls[0][0]
    expect([...edgeReg.segmentToEdge]).toEqual([0, 2])
    expect(edgeReg.segmentPositions.length).toBe(2 * 6)
    expect(edgeReg.edgeQueries).toEqual(['p1:edge0', 'p1:edge1', 'p1:edge2'])

    const vertexReg = vi.mocked(pipeline.vertexLayer.registerPart).mock.calls[0][0]
    expect(vertexReg.vertices).toEqual([[0, 0, 0], [2, 0, 0]])
    expect(vertexReg.vertexQueries).toEqual(['p1:vtx0', 'p1:vtx2'])
  })

  it('registers no edge layer at all when every curve is a hidden seam', () => {
    const { pipeline } = stubPipeline()
    const seamOnly = seamPart('p2')
    seamOnly.hiddenEdges = [0, 1, 2]
    render(tree(pipeline, [seamOnly]))
    expect(vi.mocked(pipeline.edgeLayer.registerPart)).not.toHaveBeenCalled()
  })
})

describe('AssemblyPickLayers incremental registration', () => {
  it('re-registers only the bodies whose object identity changed', () => {
    const { pipeline, registered, unregistered, reset } = stubPipeline()
    const a = part('p1')
    const b = part('p2')
    const view = render(tree(pipeline, [a, b]))
    expect(registered).toEqual(['face:p1:body_0', 'face:p2:body_0'])

    reset()
    const bMoved = part('p2')  // a fresh object, as offsetPickBodies returns for a moved part
    view.rerender(tree(pipeline, [a, bMoved]))

    // Only the moved body re-registers; the untouched one keeps its resources.
    expect(registered).toEqual(['face:p2:body_0'])
    // registerPart self-replaces, so no explicit unregister for the moved body.
    expect(unregistered).toEqual([])
  })

  it('does not touch the pipeline when the same body objects are re-passed', () => {
    const { pipeline, registered, unregistered, dirty, reset } = stubPipeline()
    const a = part('p1')
    const view = render(tree(pipeline, [a]))
    reset()

    // A fresh array holding the same body object, the at-rest viewport case.
    view.rerender(tree(pipeline, [a]))

    expect(registered).toEqual([])
    expect(unregistered).toEqual([])
    expect(dirty()).toBe(0)
  })

  it('unregisters only the bodies that left the snapshot', () => {
    const { pipeline, unregistered, reset } = stubPipeline()
    const a = part('p1')
    const b = part('p2')
    const view = render(tree(pipeline, [a, b]))
    reset()

    view.rerender(tree(pipeline, [a]))

    expect(unregistered).toEqual(['face:p2:body_0', 'edge:p2:body_0', 'vertex:p2:body_0'])
  })

  it('registers a layer only while the viewer draws it', () => {
    const { pipeline, registered, unregistered, dirty, reset } = stubPipeline()
    const a = fullPart('p1')
    const view = render(tree(pipeline, [a], { showFaces: false }))
    // Shading off: no face entries at all, the wireframe and vertices still pick.
    expect(new Set(registered)).toEqual(new Set(['edge:p1:body_0', 'vertex:p1:body_0']))
    expect(dirty()).toBe(1)

    reset()
    view.rerender(tree(pipeline, [a], { showFaces: false, showEdges: false }))
    // Both rows off is not reachable in the UI, but the component must not
    // register anything it was told not to draw. Vertices are neither row, so
    // they stay pickable.
    expect(registered).toEqual(['vertex:p1:body_0'])
    expect(unregistered).toEqual(['face:p1:body_0', 'edge:p1:body_0', 'vertex:p1:body_0'])

    reset()
    view.rerender(tree(pipeline, [a], { showFaces: true, showEdges: true }))
    expect(new Set(registered)).toEqual(new Set(['face:p1:body_0', 'edge:p1:body_0', 'vertex:p1:body_0']))
    expect(dirty()).toBe(1)
  })

  it('frees every registered body on unmount', () => {
    const { pipeline, unregistered, reset } = stubPipeline()
    const view = render(tree(pipeline, [part('p1'), part('p2')]))
    reset()

    view.unmount()

    expect(new Set(unregistered)).toEqual(new Set([
      'face:p1:body_0', 'edge:p1:body_0', 'vertex:p1:body_0',
      'face:p2:body_0', 'edge:p2:body_0', 'vertex:p2:body_0',
    ]))
  })

  it('releases the layers a body registered before one of them threw', () => {
    // The face layer lands, the edge layer throws. The catch drops the body from
    // the bookkeeping, so without unregistering here the face (and vertex)
    // registrations would outlive the body until the pipeline is disposed.
    const p2Key = 'p2:body_0'
    const { pipeline, live, reset } = stubPipeline(p2Key)
    const a = fullPart('p1')
    const b = fullPart('p2')
    const view = render(tree(pipeline, [a, b]))

    expect(live.has(`face:${p2Key}`)).toBe(false)
    expect(live.has(`vertex:${p2Key}`)).toBe(false)
    expect([...live].filter(k => k.endsWith(p2Key))).toEqual([])

    // The body leaving the snapshot must not resurrect or strand anything.
    reset()
    view.rerender(tree(pipeline, [a]))
    expect([...live].filter(k => k.endsWith(p2Key))).toEqual([])
    expect([...live].every(k => k.endsWith('p1:body_0'))).toBe(true)
  })

  it('retries a body that failed on the next tick', () => {
    // The bookkeeping must not remember the failed body as registered, or a
    // transient failure would leave it unpickable for the scene's lifetime.
    const p2Key = 'p2:body_0'
    const { pipeline, registered, reset } = stubPipeline(p2Key)
    const a = fullPart('p1')
    const b = fullPart('p2')
    const view = render(tree(pipeline, [a, b]))
    reset()

    view.rerender(tree(pipeline, [a, b]))

    expect(registered).toContain(`face:${p2Key}`)
  })
})
