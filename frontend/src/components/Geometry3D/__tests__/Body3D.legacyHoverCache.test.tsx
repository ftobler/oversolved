// Legacy meshes (no usable face_queries / triangle_to_face) rebuild two full
// per-triangle boolean arrays on EVERY hover change, for EVERY such body,
// bypassing the HighlightIndex cache that keeps hover cost independent of
// scene size for face-query meshes. This materializes the per-triangle queries
// once per body and drives them through the same HighlightIndex, so a hover
// move that does not touch a body leaves its flags reference-identical and its
// colour painter idle.
//
// A hover store write re-renders a body more than once (the store fields each
// subscribe separately), so the assertions compare the LAST recorded paint
// inputs per body -- the settled state -- never an intermediate wave.
//
// `settledFaceCalls` groups the settled wave by slicing the last N face paints,
// which assumes React renders the N bodies in mount order. That holds for the
// deterministic store writes below; a per-paint bodyId tag would make it
// immune to render ordering but would thread body identity through a hook that
// does not have it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { bodyKeyFor, primitivePickKey } from '@/picking/pickKey'
import { FACE_LAYER_NAME } from '@/picking/layerNames'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Record every useHighlightColors call. A legacy body renders no edges, so the
// face paint is the only call with a non-empty runs count, which isolates it
// from the zero-primitive edge paint. Calls arrive in body render order, so the
// last N face calls are the settled paint inputs of the N bodies.
const { facePaints } = vi.hoisted(() => ({
  facePaints: [] as { count: number; selected: readonly boolean[] | null; hovered: readonly boolean[] | null }[],
}))

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: {
      runs: { count: number }
      selected: readonly boolean[] | null
      hovered: readonly boolean[] | null
    }) => {
      facePaints.push({ count: params.runs.count, selected: params.selected, hovered: params.hovered })
      return actual.useHighlightColors(params as never)
    },
  }
})

// Count per-triangle face-query mints. The legacy path resolves its per-triangle
// queries exactly once per body (in `legacyFaceQueries`) and then lets the
// HighlightIndex answer every hover move; minting is the visible cost of that
// materialization, so a regression that rebuilt the per-triangle work on every
// hover would add N triangles of mints per move. (The HighlightIndex's own
// `compute` is not observable from outside its module, so the materialization
// memo is the seam this instruments.)
const { faceMints } = vi.hoisted(() => ({ faceMints: { n: 0 } }))

vi.mock('@/utils/query/selectionId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/query/selectionId')>()
  return {
    ...actual,
    topoFallbackQuery: (id: string, kind: 'edge' | 'face' | 'vertex', idx: number) => {
      if (kind === 'face') faceMints.n++
      return actual.topoFallbackQuery(id, kind, idx)
    },
  }
})

// One legacy quad (two triangles), no face_queries, no triangle_to_face: every
// triangle falls back to a body-keyed topo query, so bodies with distinct
// bodyIds own disjoint query sets.
function legacyMesh(): Mesh3D {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    faces: new Uint32Array([0, 1, 2, 1, 3, 2]),
  }
}

// A mapped-but-short mesh: face_queries present but triangle_to_face covering
// only the first two of four triangles. `resolveFaceQueries` rejects it (short
// mapping), so Body3D lands on the legacy per-triangle path, while the face
// layer still registers it and mints pick keys keyed on the B-rep FACE index
// (FaceIdLayer.ts). Triangle 0 and 1 both map to face 0 ('f0'); triangles 2 and
// 3 are unmapped and fall back to per-triangle queries.
function mappedButShortMesh(): Mesh3D {
  return {
    vertices: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    faces: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    face_queries: ['f0'],
    triangle_to_face: [0, 0],
  }
}

const FACES_PER_BODY = 2

function faceCalls(): typeof facePaints {
  return facePaints.filter(p => p.count > 0)
}

/** The settled paint inputs of the last `bodyCount` bodies, in render order. */
function settledFaceCalls(bodyCount: number) {
  return faceCalls().slice(-bodyCount)
}

async function renderBodies(bodyCount: number) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  const bodies = Array.from({ length: bodyCount }, (_, i) =>
    <Body3D key={i} featureId="ex1" bodyId={`body_${i}`} mesh={legacyMesh()} />)
  render(<>{bodies}</>)
}

async function setState(state: Record<string, unknown>) {
  await act(async () => { useSketchEditorStore.setState(state as never) })
}

beforeEach(async () => {
  facePaints.length = 0
  faceMints.n = 0
  await act(async () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      selectedPicks: new Map(),
      hoveredSelectionId: null,
      hoveredPickKey: null,
    } as never)
  })
})

describe('legacy triangle highlight shares the HighlightIndex cache', () => {
  it('a hover on body A re-runs only A, every other body keeps its all-false array', async () => {
    const N = 4
    await renderBodies(N)
    const before = settledFaceCalls(N)

    await setState({ hoveredSelectionId: '@body_1/face/0', hoveredPickKey: null })

    const after = settledFaceCalls(N)
    for (let i = 0; i < N; i++) {
      if (i === 1) {
        // Only the pointed body changes reference, and it paints its triangle.
        expect(after[i].hovered).not.toBe(before[i].hovered)
        expect(after[i].hovered![0]).toBe(true)
      } else {
        // An uninvolved body answers with the identical all-false array, so the
        // painter's effect keyed on it does not re-run.
        expect(after[i].hovered).toBe(before[i].hovered)
      }
    }
  })

  it('a hover moving across bodies still leaves uninvolved bodies untouched', async () => {
    const N = 3
    await renderBodies(N)
    for (const pointed of [2, 0]) {
      const before = settledFaceCalls(N)
      await setState({ hoveredSelectionId: `@body_${pointed}/face/0`, hoveredPickKey: null })
      const after = settledFaceCalls(N)
      // Only the newly pointed body, plus the previously pointed one returning
      // to all-false, may change reference. Every other body is untouched.
      const changed = after.filter((f, i) => f.hovered !== before[i].hovered)
      expect(changed.length).toBeLessThanOrEqual(2)
      for (let i = 0; i < N; i++) {
        expect(after[i].hovered).toEqual(i === pointed ? [true, false] : [false, false])
      }
    }
  })

  it('a selection growing on other bodies leaves an unselected legacy body stable', async () => {
    const N = 3
    await renderBodies(N)
    const before = settledFaceCalls(N)[0]

    // The selection really grows: each step keeps every earlier query.
    const selection = new Set<string>()
    for (let other = 1; other < N; other++) {
      selection.add(`@body_${other}/face/0`)
      await setState({ normalSelection: new Set(selection) })
    }
    const after = settledFaceCalls(N)[0]
    expect(after.selected).toBe(before.selected)
    expect(after.selected).toEqual(new Array(FACES_PER_BODY).fill(false))
  })

  it('keeps uninvolved legacy bodies behind the intersects gate, never scanning per hover', async () => {
    const N = 4
    await renderBodies(N)
    // Mount materializes the per-triangle queries once per triangle and nothing
    // else: no active set means every body answers from the shared all-false
    // array without ever reaching the O(primitives) scan.
    const mountMints = faceMints.n
    expect(mountMints).toBe(N * FACES_PER_BODY)

    for (const pointed of [1, 2, 3]) {
      await setState({ hoveredSelectionId: `@body_${pointed}/face/0`, hoveredPickKey: null })
    }
    // Hovers mint nothing: the materialized array and its index serve every
    // move, so the per-triangle work stays at one body's worth, never N.
    expect(faceMints.n).toBe(mountMints)
  })
})

describe('legacy fallback still paints the hovered/selected triangles exactly as before', () => {
  it('marks exactly the selected triangle, not the whole mesh', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1/face/1']) } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={legacyMesh()} />)

    const face = settledFaceCalls(1)
    expect(face[0]?.selected).toEqual([false, true])
  })

  it('marks exactly the hovered triangle', async () => {
    useSketchEditorStore.setState({ hoveredSelectionId: '@body_ex1/face/0' } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={legacyMesh()} />)

    const face = settledFaceCalls(1)
    expect(face[0]?.hovered).toEqual([true, false])
  })

  it('paints selection and hover through the same per-triangle runs as before', async () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(['@body_ex1/face/0']),
      hoveredSelectionId: '@body_ex1/face/1',
    } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={legacyMesh()} />)

    const face = settledFaceCalls(1)
    expect(face[0]?.selected).toEqual([true, false])
    expect(face[0]?.hovered).toEqual([false, true])
  })

  // The id layer registers mapped-but-short meshes and mints live pick keys
  // keyed on the B-rep FACE index. The legacy queries are indexed by TRIANGLE,
  // so a live per-face pick key must never be parsed as a triangle index: it
  // would claim one triangle of the face and split the highlight. Query
  // membership alone decides, exactly like the pre-index fallback.
  it('a live per-face pickKey on a mapped-but-short mesh still highlights the whole face', async () => {
    const bodyKey = bodyKeyFor('ex1', 'body_ex1')
    useSketchEditorStore.setState({
      hoveredSelectionId: 'f0',
      hoveredPickKey: primitivePickKey(bodyKey, 0, FACE_LAYER_NAME),
    } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mappedButShortMesh()} />)

    // Face 0 owns triangles 0 and 1; both must paint, the unmapped tail must not.
    expect(settledFaceCalls(1)[0]?.hovered).toEqual([true, true, false, false])
  })

  it('a per-face selectedPicks claim on a mapped-but-short mesh still selects the whole face', async () => {
    const bodyKey = bodyKeyFor('ex1', 'body_ex1')
    useSketchEditorStore.setState({
      normalSelection: new Set(['f0']),
      selectedPicks: new Map([['f0', new Set([primitivePickKey(bodyKey, 0, FACE_LAYER_NAME)])]]),
    } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mappedButShortMesh()} />)

    expect(settledFaceCalls(1)[0]?.selected).toEqual([true, true, false, false])
  })
})
