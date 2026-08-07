// The face highlight's query array was not padded to the rendered face count
// (edges and vertices are), so a kernel returning fewer `face_queries` than the
// tessellation contains left the tail faces with no query to highlight by.
// `resolveFaceQueries` pads with topo fallbacks, and the one resolved list feeds
// BOTH the face HighlightIndex and the painter's face runs, so the two can never
// disagree about how many faces there are.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { resolveFaceQueries, faceCount } from '@/components/Geometry3D/bodyGeometry'
import { HighlightIndex } from '@/picking/selectionHighlight'
import { FACE_LAYER_NAME } from '@/picking/layerNames'
import { faceRuns, HighlightColorPainter, type HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import { COLOR_SELECTED } from '@/components/Geometry3D/constants'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Captures the `runs` prop of every useHighlightColors call so a test can pin
// that Body3D hands the painter face runs counting the resolved list.
const { facePaintRuns } = vi.hoisted(() => ({ facePaintRuns: [] as { count: number }[] }))

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: { runs: { count: number } }) => {
      facePaintRuns.push({ count: params.runs.count })
      return actual.useHighlightColors(params as never)
    },
  }
})

// Three quads (two triangles each) but only TWO face queries: the tessellation
// renders face 2 with no kernel-supplied query, the alignment gap this pads.
const mesh: Mesh3D = {
  vertices: new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2,
  ]),
  faces: new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
  ]),
  triangle_to_face: [0, 0, 1, 1, 2, 2],
  face_queries: ['?f0', '?f1'],
}

beforeEach(() => {
  facePaintRuns.length = 0
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

/** The triangles each B-rep face owns, in the painter's runs' terms. */
const trianglesOf = (faceIndex: number): number[] => {
  const out: number[] = []
  mesh.triangle_to_face!.forEach((owner, tri) => { if (owner === faceIndex) out.push(tri) })
  return out
}

describe('resolveFaceQueries pads the face query list to the rendered face count', () => {
  it('produces a list of the face count with a fallback query in the tail', () => {
    const resolved = resolveFaceQueries(mesh, 'body_ex1')
    expect(faceCount(mesh.faces)).toBe(6)  // 6 triangles
    expect(resolved).toEqual(['?f0', '?f1', '@body_ex1/face/2'])
    expect(resolved!.length).toBe(3)
  })

  it('returns the raw array unchanged when the kernel supplied full coverage', () => {
    const full: Mesh3D = { ...mesh, face_queries: ['?f0', '?f1', '?f2'] }
    // Identity, not just equality: the HighlightIndex memo is keyed on it.
    expect(resolveFaceQueries(full, 'body_ex1')).toBe(full.face_queries)
  })

  it('returns null when the mesh carries no face queries (legacy triangle path)', () => {
    const legacy: Mesh3D = {
      vertices: mesh.vertices,
      faces: mesh.faces,
      triangle_to_face: [0, 0, 1, 1, 2, 2],
    }
    expect(resolveFaceQueries(legacy, 'body_ex1')).toBeNull()
  })

  it('returns null when triangle_to_face does not cover the triangles', () => {
    const short: Mesh3D = { ...mesh, triangle_to_face: [0, 0] }
    expect(resolveFaceQueries(short, 'body_ex1')).toBeNull()
  })
})

describe('face HighlightIndex and painter agree on one primitive count', () => {
  it('count from the SAME resolved array, so the tail faces are paint primitives', () => {
    const resolved = resolveFaceQueries(mesh, 'body_ex1')!
    const index = new HighlightIndex('ex1/body_ex1', FACE_LAYER_NAME, resolved)
    const runs = faceRuns(resolved.length, trianglesOf)

    expect(index.none.length).toBe(resolved.length)
    expect(runs.count).toBe(resolved.length)
    // The discriminator: a painter still counting raw face_queries would say 2
    // while the index says 3, the exact mismatch that left tail faces dead.
    expect(mesh.face_queries!.length).toBe(2)
    expect(runs.count).not.toBe(mesh.face_queries!.length)
  })

  it('a tail fallback selection paints the tail face through both consumers', () => {
    const resolved = resolveFaceQueries(mesh, 'body_ex1')!
    const index = new HighlightIndex('ex1/body_ex1', FACE_LAYER_NAME, resolved)
    const colors = new Float32Array(faceCount(mesh.faces) * 9)
    const painter = new HighlightColorPainter(colors, faceRuns(resolved.length, trianglesOf))
    const palette: HighlightPalette = { base: [0, 0, 0], selected: [1, 0, 0], hovered: [0, 1, 0] }

    const selected = index.compute({
      queries: new Set(['@body_ex1/face/2']),
      pickKeys: new Map<string, ReadonlySet<string>>(),
    })
    painter.apply(selected, null, palette)

    // Face 2 owns triangles 4 and 5: vertex slots 12..17 turn selected.
    for (let v = 12; v < 18; v++) {
      expect([...colors.slice(v * 3, v * 3 + 3)]).toEqual([1, 0, 0])
    }
    // Faces 0 and 1 keep the base colour.
    expect([...colors.slice(0, 3)]).toEqual([0, 0, 0])
  })
})

describe('Body3D renders a tail-face highlight through the fallback', () => {
  it('highlights face 2 when its topo fallback query is selected', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1/face/2']) } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    const { container } = render(
      <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} />
    )
    // No edges are passed, so the only line material is the face selection outline.
    const mat = container.querySelector('linebasicmaterial')
    expect(mat?.getAttribute('color')).toBe(COLOR_SELECTED)
  })

  it('draws no face overlay when no tail face is selected', async () => {
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    const { container } = render(
      <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} />
    )
    expect(container.querySelector('linebasicmaterial')).toBeNull()
  })

  it('hands the painter face runs counting the resolved list, not raw queries', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1/face/2']) } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} />)
    // The face paint is the first useHighlightColors call; its runs must count
    // the padded list (3), so the painter's primitive count equals the highlight
    // index's in Body3D's actual wiring, not just in the pure helpers.
    expect(facePaintRuns[0]?.count).toBe(3)
  })
})
