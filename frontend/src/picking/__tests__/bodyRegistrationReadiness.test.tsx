import { describe, it, expect, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { renderHook, act, render } from '@testing-library/react'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline, getLivePipeline } from '../IdPipelineContext'
import { useIdPipelineLifecycle } from '../useIdPipelineLifecycle'
import { useFaceIdRegistration } from '../useFaceIdRegistration'
import { useEdgeIdRegistration } from '../useEdgeIdRegistration'
import { useVertexIdRegistration } from '../useVertexIdRegistration'

// A fresh IdPipeline starts dirty, so callers clear it with a render before
// asserting on the dirty flag. This renderer completes a render without throwing.
function goodRenderer(): THREE.WebGLRenderer {
  return {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
    getClearColor: () => {},
    getClearAlpha: () => 0,
    setClearColor: () => {},
    clear: () => {},
    clearDepth: () => {},
    render: () => {},
    getViewport: () => new THREE.Vector4(),
    setViewport: () => {},
    getScissor: () => new THREE.Vector4(),
    setScissor: () => {},
    getScissorTest: () => false,
    setScissorTest: () => {},
    readRenderTargetPixels: () => {},
  } as unknown as THREE.WebGLRenderer
}

function clearDirty(p: IdPipeline): void {
  p.renderIfDirty(goodRenderer(), new THREE.Camera())
}

function faceMesh(queries: string[] = ['face@q']): Mesh3D {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    faces: new Uint32Array([0, 1, 2]),
    triangle_to_face: [0],
    face_queries: queries,
  }
}

function edgeArgs(queries: string[] = ['edge@q']) {
  const edges: EdgeData[] = [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }]
  return { edges, edgeQueries: queries }
}

// After g4-H1 geometry, not queries, gates registration: an edge the kernel
// left unnamed still registers with a topo fallback. "Empty" therefore means
// no geometry at all.
function edgeArgsEmpty() {
  return { edges: [] as EdgeData[], edgeQueries: [] as string[] }
}

function vertexArgs(queries: string[] = ['vertex@q']) {
  const vertices: [number, number, number][] = [[0, 0, 0]]
  return { vertices, vertexQueries: queries }
}

function vertexArgsEmpty() {
  return { vertices: [] as [number, number, number][], vertexQueries: [] as string[] }
}

interface HookCase {
  name: string
  makeValid: () => unknown
  makeEmpty: () => unknown
  useRun: (args: unknown) => void  // the registration hook call, must start with "use"
  bodyCount: (p: IdPipeline) => number
  registrySize: (p: IdPipeline) => number
  layer: (p: IdPipeline) => { registerBody: (...a: never[]) => unknown }
}

const cases: HookCase[] = [
  {
    name: 'face',
    makeValid: () => faceMesh(),
    makeEmpty: () => faceMesh([]),
    useRun: (a) => useFaceIdRegistration({ featureId: 'f', bodyId: 'b', mesh: a as Mesh3D }),
    bodyCount: (p) => p.faceLayer.bodyCount(),
    registrySize: (p) => p.registry.size(),
    layer: (p) => p.faceLayer,
  },
  {
    name: 'edge',
    makeValid: () => edgeArgs(),
    makeEmpty: () => edgeArgsEmpty(),
    useRun: (a) => {
      const x = a as ReturnType<typeof edgeArgs>
      useEdgeIdRegistration({ featureId: 'f', bodyId: 'b', edges: x.edges, edgeQueries: x.edgeQueries })
    },
    bodyCount: (p) => p.edgeLayer.bodyCount(),
    registrySize: (p) => p.registry.size(),
    layer: (p) => p.edgeLayer,
  },
  {
    name: 'vertex',
    makeValid: () => vertexArgs(),
    makeEmpty: () => vertexArgsEmpty(),
    useRun: (a) => {
      const x = a as ReturnType<typeof vertexArgs>
      useVertexIdRegistration({ featureId: 'f', bodyId: 'b', vertices: x.vertices, vertexQueries: x.vertexQueries })
    },
    bodyCount: (p) => p.vertexLayer.bodyCount(),
    registrySize: (p) => p.registry.size(),
    layer: (p) => p.vertexLayer,
  },
]

describe('body registration readiness', () => {
  afterEach(() => { setLivePipeline(null) })

  for (const c of cases) {
    describe(c.name, () => {
      it('registers geometry that mounted before the pipeline was published', () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        renderHook(() => c.useRun(c.makeValid()))
        expect(c.bodyCount(pipeline)).toBe(0)
        act(() => { setLivePipeline(pipeline) })
        expect(c.bodyCount(pipeline)).toBe(1)
        expect(c.registrySize(pipeline)).toBe(1)
      })

      it('registers geometry that arrives after the pipeline is live', () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        setLivePipeline(pipeline)
        const { rerender } = renderHook((a) => c.useRun(a), { initialProps: c.makeEmpty() })
        expect(c.bodyCount(pipeline)).toBe(0)
        rerender(c.makeValid())
        expect(c.bodyCount(pipeline)).toBe(1)
      })

      it('marks the id buffer dirty when geometry lands', () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        setLivePipeline(pipeline)
        clearDirty(pipeline)
        expect(pipeline.isDirty()).toBe(false)
        renderHook(() => c.useRun(c.makeValid()))
        expect(pipeline.isDirty()).toBe(true)
        expect(pipeline.getLastDirtyReason()).toBe('registration')
      })

      it('leaves the buffer clean when registration refuses', () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        setLivePipeline(pipeline)
        clearDirty(pipeline)
        renderHook(() => c.useRun(c.makeEmpty()))
        expect(c.bodyCount(pipeline)).toBe(0)
        expect(pipeline.isDirty()).toBe(false)
      })

      it('registers a body exactly once under a StrictMode double mount', () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        setLivePipeline(pipeline)
        renderHook(() => c.useRun(c.makeValid()), { wrapper: StrictMode })
        expect(c.bodyCount(pipeline)).toBe(1)
        expect(c.registrySize(pipeline)).toBe(1)
      })
    })
  }

  // resolveFaceQueries accepts a query set that outnumbers the triangles (it
  // bounds the index space), so a mesh with queries but zero triangles slips
  // past it. The hook's own triangle-count guard is what keeps it from
  // registering an empty face body.
  it('does not register a face mesh with queries but no triangles', () => {
    const pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)
    renderHook(() => useFaceIdRegistration({
      featureId: 'f',
      bodyId: 'b',
      mesh: {
        vertices: new Float32Array(0),
        faces: new Uint32Array(0),
        triangle_to_face: [],
        face_queries: ['face@q'],
      } as Mesh3D,
    }))

    expect(pipeline.faceLayer.bodyCount()).toBe(0)
    expect(pipeline.registry.size()).toBe(0)
  })

  // The replacement-pipeline case registers into a fresh pipeline minted by the
  // lifecycle hook (the real cold-load reveal). A Suspense hide/reveal is, to the
  // subtree, exactly a cleanup-then-setup cycle: React unmounts the hidden
  // children (running effect cleanups) and remounts them when the boundary
  // resolves. Reproduce that deterministically with an unmount + remount, which
  // is bit-for-bit the same lifecycle the production boundary performs. This
  // proves geometry converges on the new pipeline and the old one is torn down
  // without leaking ids.
  describe('re-registration across a lifecycle reveal', () => {
    function Harness({ register }: { register: () => void }) {
      useIdPipelineLifecycle(() => new IdPipeline({ width: 32, height: 32 }))
      register()
      return null
    }

    afterEach(() => { setLivePipeline(null) })

    for (const c of cases) {
      it(`re-registers every body into the replacement pipeline (${c.name})`, () => {
        const register = () => c.useRun(c.makeValid())
        const view = render(<Harness register={register} />)
        const A = getLivePipeline() as IdPipeline
        expect(c.bodyCount(A)).toBe(1)

        // The reveal: the Suspense boundary hides then re-shows the subtree.
        act(() => { view.unmount() })
        expect(A.isDisposed()).toBe(true)
        expect(getLivePipeline()).toBeNull()

        act(() => { render(<Harness register={register} />) })
        const B = getLivePipeline() as IdPipeline
        expect(B).not.toBe(A)
        expect(B.isDisposed()).toBe(false)
        expect(c.bodyCount(B)).toBe(1)
        // The old pipeline is fully torn down and leaks no ids.
        expect(c.bodyCount(A)).toBe(0)
        expect(c.registrySize(A)).toBe(0)
      })
    }
  })

  // `IdRegistry.allocate` throws on 24-bit ID exhaustion, and a passive-effect
  // throw unmounts the viewport root (no error boundary above it). Each body
  // hook must warn and continue with that body unregistered, not propagate.
  describe('a throwing registerBody is swallowed', () => {
    afterEach(() => { setLivePipeline(null); vi.restoreAllMocks() })

    for (const c of cases) {
      it(`${c.name}: warns and leaves the body unregistered without throwing`, () => {
        const pipeline = new IdPipeline({ width: 32, height: 32 })
        setLivePipeline(pipeline)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(c.layer(pipeline), 'registerBody').mockImplementation(() => {
          throw new Error('IdRegistry: exhausted 24-bit ID space')
        })

        expect(() => renderHook(() => c.useRun(c.makeValid()))).not.toThrow()
        expect(c.bodyCount(pipeline)).toBe(0)
        expect(warn).toHaveBeenCalled()
        pipeline.dispose()
      })
    }
  })
})
