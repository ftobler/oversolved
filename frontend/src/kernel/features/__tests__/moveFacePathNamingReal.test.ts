// @vitest-environment node
//
// The direct move-face naming contract: a neighbour grows and keeps its own
// UUID, so no `|extend|` face is minted in the first place. An old document
// that picked an extension face by its dead `<f>|extend|<n>` UUID is handed off
// to the neighbour through the path's own lineage (the path names `<n>`), which
// is a verified hash probe, not a geometry guess.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import {
  constructionUuidToken,
  makeAncestryQuery,
  parseAncestry,
  ref,
} from '../../query'
import { mintFaceUuid, moveFaceExtendPath } from '../../constructionName'
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

interface PartView {
  mesh?: { face_queries?: string[]; vertices?: number[][] }
}

const uuidOf = (q: string): string | null => {
  const tok = parseAncestry(q)[0].find((i) => i.startsWith('@u|'))
  return tok === undefined ? null : tok.slice(3)
}
const faceAt = (parts: Record<string, unknown>, cls: string): string => {
  const queries = ((Object.values(parts)[0] as PartView).mesh?.face_queries) ?? []
  const hit = queries.find((q) => q.includes(cls))
  if (hit === undefined) throw new Error(`no ${cls} face`)
  return hit
}
const bboxMaxX = (part: PartView): number => {
  const verts = part.mesh?.vertices ?? []
  let max = -Infinity
  for (const v of verts) max = Math.max(max, v[0])
  return max
}

describe.skipIf(!oc || !solveBytes)('move-face direct naming (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const PART = 'body_ex1'

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  it('the direct tweak mints no extension face and keeps the neighbour UUID', () => {
    const base = h.run(boxSpec())
    const top = faceAt(base.bodies, 'cls_zp')
    const side = faceAt(base.bodies, 'cls_xp')
    const sideUuid = uuidOf(side)
    if (sideUuid === null) throw new Error('the side face has no UUID')
    minted.length = 0
    const r = h.run({ features: [
      ...boxSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 2 } },
    ] })
    expect(h.res(r, 'mf1').status).toBe('ok')
    // No `|extend|` path was minted at all: the neighbour grew in place.
    expect(minted).toEqual([])
    const queries = ((h.part(r, PART) as PartView).mesh?.face_queries) ?? []
    expect(queries.filter((q) => uuidOf(q) === sideUuid)).toHaveLength(1)
  })

  it('a dead extension pick resolves to its neighbour through the verified hand-off', () => {
    const base = h.run(boxSpec())
    const sideUuid = uuidOf(faceAt(base.bodies, 'cls_xp'))
    if (sideUuid === null) throw new Error('the side face has no UUID')
    const moved = h.run({ features: [
      ...boxSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [faceAt(base.bodies, 'cls_zp')], distance: 2 } },
    ] })
    expect(h.res(moved, 'mf1').status).toBe('ok')
    // The face an old document would have picked: the extension of the +X
    // neighbour, minted by the old slab route and dead after the direct move.
    const dead = mintFaceUuid(moveFaceExtendPath('mf1', sideUuid))
    const liveUuids = (((h.part(moved, PART) as PartView).mesh?.face_queries) ?? []).map(uuidOf)
    expect(liveUuids).not.toContain(dead)
    const deadPick = makeAncestryQuery(
      [constructionUuidToken(dead), ref('ex1'), ref(PART), ref('cls_xp')],
      'flatface',
    )
    const r = h.run({ features: [
      ...boxSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [faceAt(base.bodies, 'cls_zp')], distance: 2 } },
      { id: 'mf2', kind: 'move_face', move_face: { faces: [deadPick], distance: 1 } },
    ] })
    expect(h.res(r, 'mf2').status, String(h.res(r, 'mf2').exception ?? '')).toBe('ok')
    // mf2 resolved to the +X neighbour and grew it by 1.
    expect(bboxMaxX(h.part(r, PART) as PartView)).toBeCloseTo(11, 6)
  })
})
