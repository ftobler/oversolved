// During a settle the drawn pick geometry is re-derived every tick. Only the
// bodies that actually moved get new objects, so the registration must diff on
// object identity: re-registering the whole scene every frame would rebuild
// every id buffer and dirty the pick pass for a drag that moved one part.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { IdPipelineContext, type IdPipeline } from '@/picking'
import AssemblyPickLayers from '@/components/Viewport/assembly/AssemblyPickLayers'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

function body(handle: string): AssemblyPickBody {
  return {
    handle,
    bodyKey: `${handle}:body_0`,
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

function fullBody(handle: string): AssemblyPickBody {
  return {
    ...body(handle),
    edges: {
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: [`${handle}:edge0`],
    },
    vertices: { vertices: [[0, 0, 0]], vertexQueries: [`${handle}:vtx0`] },
  }
}

function stubPipeline() {
  const registered: string[] = []
  const unregistered: string[] = []
  let dirty = 0
  const layer = (kind: string) => ({
    registerBody: vi.fn((reg: { bodyKey: string }) => { registered.push(`${kind}:${reg.bodyKey}`) }),
    unregisterBody: vi.fn((bodyKey: string) => { unregistered.push(`${kind}:${bodyKey}`) }),
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
    dirty: () => dirty,
    reset: () => { registered.length = 0; unregistered.length = 0; dirty = 0 },
  }
}

function tree(pipeline: IdPipeline, bodies: AssemblyPickBody[], layers: { showFaces?: boolean; showEdges?: boolean } = {}) {
  return (
    <IdPipelineContext.Provider value={pipeline}>
      <AssemblyPickLayers bodies={bodies} {...layers} />
    </IdPipelineContext.Provider>
  )
}

describe('AssemblyPickLayers incremental registration', () => {
  it('re-registers only the bodies whose object identity changed', () => {
    const { pipeline, registered, unregistered, reset } = stubPipeline()
    const a = body('p1')
    const b = body('p2')
    const view = render(tree(pipeline, [a, b]))
    expect(registered).toEqual(['face:p1:body_0', 'face:p2:body_0'])

    reset()
    const bMoved = body('p2')  // a fresh object, as offsetPickBodies returns for a moved part
    view.rerender(tree(pipeline, [a, bMoved]))

    // Only the moved body re-registers; the untouched one keeps its resources.
    expect(registered).toEqual(['face:p2:body_0'])
    // registerBody self-replaces, so no explicit unregister for the moved body.
    expect(unregistered).toEqual([])
  })

  it('does not touch the pipeline when the same body objects are re-passed', () => {
    const { pipeline, registered, unregistered, dirty, reset } = stubPipeline()
    const a = body('p1')
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
    const a = body('p1')
    const b = body('p2')
    const view = render(tree(pipeline, [a, b]))
    reset()

    view.rerender(tree(pipeline, [a]))

    expect(unregistered).toEqual(['face:p2:body_0', 'edge:p2:body_0', 'vertex:p2:body_0'])
  })

  it('registers a layer only while the viewer draws it', () => {
    const { pipeline, registered, unregistered, dirty, reset } = stubPipeline()
    const a = fullBody('p1')
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
    const view = render(tree(pipeline, [body('p1'), body('p2')]))
    reset()

    view.unmount()

    expect(new Set(unregistered)).toEqual(new Set([
      'face:p1:body_0', 'edge:p1:body_0', 'vertex:p1:body_0',
      'face:p2:body_0', 'edge:p2:body_0', 'vertex:p2:body_0',
    ]))
  })
})
