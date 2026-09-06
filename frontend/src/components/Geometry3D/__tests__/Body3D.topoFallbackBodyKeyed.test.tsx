// The topo fallback fires only where the kernel supplied no query for a
// primitive, and it used to be keyed on `created_by`: `body_ex1` and
// `body_ex1_1` -- two bodies of ONE feature (kernel/features/bodySplit.ts) --
// then both minted `@ex1/edge/0` for their own edge 0. Two different edges,
// one query string: duplicate-query warnings and cross-body highlight.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Mesh3D, EdgeData } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { minted } = vi.hoisted(() => ({ minted: [] as string[] }))

vi.mock('@/utils/query/selectionId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/query/selectionId')>()
  return {
    ...actual,
    topoFallbackQuery: (id: string, kind: 'edge' | 'face' | 'vertex', idx: number) => {
      const q = actual.topoFallbackQuery(id, kind, idx)
      minted.push(q)
      return q
    },
  }
})

// No face_queries, no edge_queries, no vertex_queries: every primitive falls
// back, which is the only state in which the fallback is used at all.
const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
}
const edges: EdgeData[] = [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }]
const vertices: [number, number, number][] = [[0, 0, 0]]

beforeEach(() => {
  minted.length = 0
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

// Both bodies belong to feature `ex1`; only their body ids separate them.
async function renderSibling(bodyId: string) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D featureId="ex1" bodyId={bodyId} mesh={mesh} edges={edges} vertices={vertices} />
  )
}

describe('Body3D topo-fallback queries are keyed on the body', () => {
  // All three mint sites run during this render: the face one is reached
  // through `legacyFaceQueries`, the per-triangle paint path taken when the
  // mesh carries no `face_queries`.
  it('names the body, not the feature that created it', async () => {
    await renderSibling('body_ex1')
    expect(minted).toContain('@body_ex1/edge/0')
    expect(minted).toContain('@body_ex1/vertex/0')
    expect(minted).toContain('@body_ex1/face/0')
    expect(minted.some(q => q.startsWith('@ex1/'))).toBe(false)
  })

  it('gives two siblings of one feature disjoint queries', async () => {
    await renderSibling('body_ex1')
    const first = [...minted]
    minted.length = 0
    await renderSibling('body_ex1_1')
    const second = [...minted]

    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBe(first.length)
    expect(second.filter(q => first.includes(q))).toEqual([])
  })

  // Cheap guard for a mint site added later, which the assertions above would
  // not see: no site may take the feature id, however many there are. The
  // edge/vertex/face resolvers moved to bodyGeometry (one padded list feeds both
  // the highlight index and the ID-layer registration), so scan both files.
  it('has no feature-keyed mint site left in Body3D or bodyGeometry', () => {
    const src = ['Body3D.tsx', 'bodyGeometry.ts']
      .map(f => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n')
    const sites = [...src.matchAll(/topoFallbackQuery\(\s*(\w+)/g)].map(m => m[1])
    expect(sites.length).toBeGreaterThanOrEqual(3)  // edge, vertex, face
    expect(sites.filter(s => s !== 'bodyId')).toEqual([])
  })
})
