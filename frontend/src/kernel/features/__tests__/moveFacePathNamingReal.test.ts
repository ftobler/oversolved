// @vitest-environment node
//
// One naming scheme for both move-face paths. A group the intermediate shape
// refuses (an unsound boolean, a neighbour an earlier move left unable to cross
// the next slab) is applied as one set on the original body; a live-UUID group
// goes one pick at a time. The set path appended a per-pick suffix to each
// extend name whenever the group had several picks, the sequential path never
// did, so an upstream dimension change that flipped the paths re-minted every
// extension UUID even though the geometry was the same.
//
// The naming functions are observed rather than the resulting face UUIDs: an
// extend name that the boolean merges into an existing face leaves no trace in
// the body, yet it was still minted and is what the next build feeds back in.
// A pick with no construction-UUID token forces the set path while still
// resolving by stable ancestry, so both paths run over the same two faces.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry, makeAncestryQuery } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const { minted } = vi.hoisted(() => ({ minted: [] as string[] }))

vi.mock('../../constructionName', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../constructionName')>()
  return {
    ...actual,
    moveFaceExtendPath: (featureId: string, neighbourUuid: string) => {
      const path = actual.moveFaceExtendPath(featureId, neighbourUuid)
      minted.push(path)
      return path
    },
    moveFaceSetExtendPath: (featureId: string, neighbourUuid: string, pickIndex: number) => {
      const path = actual.moveFaceSetExtendPath(featureId, neighbourUuid, pickIndex)
      minted.push(path)
      return path
    },
  }
})

const oc = await loadOcc()
const solveBytes = loadSolver()

/** The query without its construction-UUID token: resolvable by stable
 *  ancestry, but `needsSet` (a dead UUID) in the leaf. */
function withoutUuid(q: string): string {
  const [ids, typeRestriction] = parseAncestry(q)
  return makeAncestryQuery(ids.filter((i) => !i.startsWith('@u|')), typeRestriction)
}

/** A cylinder about +Z: circle sketch + extrude along the plane normal. */
function cylinderSpec(r = 5, h = 10): { features: Array<Record<string, unknown>> } {
  return { features: [
    {
      id: 'sk1', kind: 'sketch', label: 'Circle', plane: '@builtin_plane_front',
      entities: [{ id: 'c1', kind: 'circle' }],
      initial: { c1: [0, 0, r] },
      constraints: [
        { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
        { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 2 * r },
      ],
    },
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: h, direction: 'normal', operation: 'new' },
  ]}
}

interface BodyView {
  mesh?: {
    face_queries?: string[]
    face_data?: { normal: number[] }[]
  }
}
const faceQueries = (body: unknown): string[] => ((body as BodyView).mesh?.face_queries) ?? []
const faceAt = (bodies: Record<string, unknown>, cls: string): string => {
  const hit = faceQueries(Object.values(bodies)[0]).find((q) => q.includes(cls))
  if (hit === undefined) throw new Error(`no ${cls} face`)
  return hit
}
/** The lateral (radially normal) face of the extruded cylinder. */
const lateralFace = (bodies: Record<string, unknown>): string => {
  const body = Object.values(bodies)[0] as BodyView
  const queries = body.mesh?.face_queries ?? []
  const data = body.mesh?.face_data ?? []
  for (let i = 0; i < queries.length; i++) {
    if (data[i] && Math.abs(data[i].normal[2]) < 1e-6) return queries[i]
  }
  throw new Error('no lateral face')
}

describe.skipIf(!oc || !solveBytes)('move-face path naming (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  it('a two-pick move mints the same extension names sequentially and as a set', () => {
    const base = h.run(cylinderSpec())
    const lateral = lateralFace(base.bodies)
    const cap = faceAt(base.bodies, 'cls_zp')

    const run = (faces: string[]): string[] => {
      minted.length = 0
      const r = h.run({ features: [
        ...cylinderSpec().features,
        { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 2 } },
      ] })
      expect(h.res(r, 'mf1').status).toBe('ok')
      return [...new Set(minted)].sort()
    }
    const sequential = run([lateral, cap])
    // The no-UUID wall pick still resolves by its stable ancestry, but a query
    // without a live construction UUID makes the leaf apply the group as a set.
    const asSet = run([withoutUuid(lateral), cap])
    expect(sequential.length).toBeGreaterThan(0)
    expect(asSet).toEqual(sequential)
    // A multi-pick group names by pick index on both paths.
    for (const path of sequential) expect(path).toMatch(/\|set\|[01]$/)
  })

  it('a single-pick move keeps the unreleased extend name', () => {
    // The per-pick suffix only exists for a multi-pick group, so a one-face
    // move from a stored document keeps resolving without a migration.
    const base = h.run(cylinderSpec())
    const lateral = lateralFace(base.bodies)
    minted.length = 0
    const r = h.run({ features: [
      ...cylinderSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [lateral], distance: 2 } },
    ] })
    expect(h.res(r, 'mf1').status).toBe('ok')
    expect(minted.length).toBeGreaterThan(0)
    expect(minted.every((path) => !path.includes('|set|'))).toBe(true)
  })
})
