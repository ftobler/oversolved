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
// Both paths run over the same two faces: the sequential side uses a pick with
// no construction-UUID token (it resolves by stable ancestry, as a pre-split
// document does), and the set side is forced by a refused sequential apply
// because the route now follows the resolution, not the stored UUID.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry, makeAncestryQuery } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const { minted, forcedSequentialRefusal } = vi.hoisted(() => ({
  minted: [] as string[],
  forcedSequentialRefusal: { value: false },
}))

vi.mock('../../occ/moveFace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/moveFace')>()
  return {
    ...actual,
    applyMoveFace: (...args: Parameters<typeof actual.applyMoveFace>) => {
      if (forcedSequentialRefusal.value) {
        throw new actual.MoveFaceRefusal('move_face: forced sequential refusal for the set-path test')
      }
      return actual.applyMoveFace(...args)
    },
  }
})

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
 *  ancestry, exactly how a pre-split document's pick reaches a live face. */
function withoutUuid(q: string): string {
  const [ids, typeRestriction] = parseAncestry(q)
  return makeAncestryQuery(ids.filter((i) => !i.startsWith('@u|')), typeRestriction)
}

/** A 10 x 10 x 5 box: the two caps are not adjacent, so the set path applies
 *  both while the per-pick extend names still mint. */
function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function boxSpec(d = 5): { features: Array<Record<string, unknown>> } {
  return { features: [
    rectSketch('sk1', 10, 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new' },
  ] }
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

interface PartView {
  mesh?: {
    face_queries?: string[]
    face_data?: { normal: number[] }[]
  }
}
const faceQueries = (part: unknown): string[] => ((part as PartView).mesh?.face_queries) ?? []
const faceAt = (parts: Record<string, unknown>, cls: string): string => {
  const hit = faceQueries(Object.values(parts)[0]).find((q) => q.includes(cls))
  if (hit === undefined) throw new Error(`no ${cls} face`)
  return hit
}
/** The lateral (radially normal) face of the extruded cylinder. */
const lateralFace = (parts: Record<string, unknown>): string => {
  const part = Object.values(parts)[0] as PartView
  const queries = part.mesh?.face_queries ?? []
  const data = part.mesh?.face_data ?? []
  for (let i = 0; i < queries.length; i++) {
    if (data[i] && Math.abs(data[i].normal[2]) < 1e-6) return queries[i]
  }
  throw new Error('no lateral face')
}

describe.skipIf(!oc || !solveBytes)('move-face path naming (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  afterEach(() => { forcedSequentialRefusal.value = false })

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  it('a two-pick move mints the same extension names sequentially and as a set', () => {
    const base = h.run(boxSpec())
    const top = faceAt(base.bodies, 'cls_zp')
    const bottom = faceAt(base.bodies, 'cls_zn')

    const run = (faces: string[], forceSet = false): string[] => {
      minted.length = 0
      forcedSequentialRefusal.value = forceSet
      const r = h.run({ features: [
        ...boxSpec().features,
        { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 2 } },
      ] })
      expect(h.res(r, 'mf1').status).toBe('ok')
      return [...new Set(minted)].sort()
    }
    // The no-UUID top pick resolves by its stable ancestry, so the leaf runs
    // the sequential path; refusing that apply forces the set path over the
    // same two, non-adjacent caps.
    const sequential = run([withoutUuid(top), bottom])
    const asSet = run([withoutUuid(top), bottom], true)
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
