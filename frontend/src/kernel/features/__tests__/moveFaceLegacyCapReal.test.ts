// @vitest-environment node
//
// The move-face regression reported on 2026-11-22: a 19 x 35 x 27 box stores
// four live side-wall UUIDs and a bottom-cap pick minted before caps were keyed
// by their region entities. The full resolver hands that dead cap off by its
// verified lineage, but the leaf used to choose its route from the RAW pick
// UUID, so one dead pick sent the whole group to the one-boolean set path. Each
// slab there is bounded by the pick's neighbours on their ORIGINAL surfaces, so
// neighbouring picks leave notches at every shared edge and corner (25117 mm3
// and 22 faces instead of the 23 x 39 x 29 box).
//
// These tests pin the route on the resolution, not the stored UUID, and pin the
// set path's refusal to notch adjacent picks silently. The set-path tests force
// the route by making the sequential apply refuse, the second trigger the plan
// allows besides a resolved-but-nameless pick.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, faceCentroid } from '../../occ/primitives'
import { canonicalFaces } from '../../occ/partNames'
import { volumeOf } from '../../occ/volume'
import {
  Repository,
  constructionUuidToken,
  makeAncestryQuery,
  parseAncestry,
  ref,
} from '../../query'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { solveMoveFace } from '../moveFace'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { partSpecFromText } from '@/utils/partExport'
import type { BuildResponse } from '../../builder'
import type { PartSolid } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const { forcedSequentialRefusal } = vi.hoisted(() => ({ forcedSequentialRefusal: { value: false } }))

// The real OCC construction stays in place; only the sequential apply is made
// to refuse, which is the leaf's second set-path trigger. A refusal is a real
// MoveFaceRefusal, so the leaf retries the group through its normal fallback.
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

const oc = await loadOcc()
const solveBytes = loadSolver()

const MOVE_ID = 'Pqa8cKOIZ02jshDxVx8typkI'
const EXTRUDE_ID = 'ItndFzj0p5ptXDPqsLWTaKPm'
const PART_ID = `body_${EXTRUDE_ID}`
const BOTTOM_PICK = 4

interface FaceInfo {
  normal?: number[]
  centroid?: number[]
}
interface PartView {
  mesh?: { face_queries?: string[]; face_data?: FaceInfo[]; vertices?: number[][] }
  vertices?: unknown[]
}

const uuidOf = (q: string): string | null => {
  const tok = parseAncestry(q)[0].find((i) => i.startsWith('@u|'))
  return tok === undefined ? null : tok.slice(3)
}

function bbox(part: PartView): number[] {
  const verts = part.mesh?.vertices ?? []
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], v[i])
    max[i] = Math.max(max[i], v[i])
  }
  return [...min, ...max]
}

const faceQueries = (part: PartView): string[] => part.mesh?.face_queries ?? []

/** The one face query whose tessellated normal + centroid satisfy `match`. */
function faceQueryWhere(
  parts: Record<string, unknown>,
  match: (normal: number[], centroid: number[]) => boolean,
): string {
  const part = Object.values(parts)[0] as PartView
  const queries = faceQueries(part)
  const data = part.mesh?.face_data ?? []
  for (let i = 0; i < queries.length; i++) {
    const d = data[i]
    if (d?.normal !== undefined && d.centroid !== undefined && match(d.normal, d.centroid)) return queries[i]
  }
  throw new Error(`no face matched among ${queries.length} faces`)
}

/** The report document exactly as it was stored, loaded through the one loader. */
const REPORT_RECIPE = readFileSync(
  join(process.cwd(), 'regressions', 'move-face-legacy-cap', 'recipe.yaml'),
  'utf8',
)
const REPORT_DOC = partSpecFromText(REPORT_RECIPE)

/** A straight L profile extruded along the front normal: the left arm's outer
 *  wall and top join each other, and the right arm's outer wall touches neither. */
function lProfileSpec(): { features: Array<Record<string, unknown>> } {
  return { features: [
    {
      id: 'sk1', kind: 'sketch', label: 'L profile', plane: '@builtin_plane_front',
      entities: ['bottom', 'right', 'innerTop', 'innerLeft', 'top', 'left']
        .map((id) => ({ id, kind: 'line' as const })),
      initial: {
        bottom: [0, 0, 30, 0], right: [30, 0, 30, 10],
        innerTop: [30, 10, 10, 10], innerLeft: [10, 10, 10, 30],
        top: [10, 30, 0, 30], left: [0, 30, 0, 0],
      },
      constraints: [
        { id: 'co1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
        { id: 'co2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'innerTop', point: 'start' } },
        { id: 'co3', kind: 'coincident', a: { entity: 'innerTop', point: 'end' }, b: { entity: 'innerLeft', point: 'start' } },
        { id: 'co4', kind: 'coincident', a: { entity: 'innerLeft', point: 'end' }, b: { entity: 'top', point: 'start' } },
        { id: 'co5', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
        { id: 'co6', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
        { id: 'h1', kind: 'horizontal', target: { entity: 'bottom' } },
        { id: 'v1', kind: 'vertical', target: { entity: 'right' } },
        { id: 'h2', kind: 'horizontal', target: { entity: 'innerTop' } },
        { id: 'v2', kind: 'vertical', target: { entity: 'innerLeft' } },
        { id: 'h3', kind: 'horizontal', target: { entity: 'top' } },
        { id: 'v3', kind: 'vertical', target: { entity: 'left' } },
        { id: 'l1', kind: 'length', target: { entity: 'bottom' }, value: 30 },
        { id: 'l2', kind: 'length', target: { entity: 'right' }, value: 10 },
        { id: 'l3', kind: 'length', target: { entity: 'innerTop' }, value: 20 },
        { id: 'l4', kind: 'length', target: { entity: 'innerLeft' }, value: 20 },
        { id: 'l5', kind: 'length', target: { entity: 'top' }, value: 10 },
        { id: 'l6', kind: 'length', target: { entity: 'left' }, value: 30 },
      ],
    },
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
  ] }
}

describe.skipIf(!oc || !solveBytes)('move-face legacy cap (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterEach(() => { forcedSequentialRefusal.value = false })

  // The checkpoint's body volume; the build response carries only the mesh.
  function volumeAfter(result: BuildResponse, lastId: string, partId = PART_ID): number {
    const handle = result._build_state.checkpoints[lastId]?.body_store_snapshot?.[partId]?.shape
    if (!handle) throw new Error(`no checkpoint shape for ${lastId}/${partId}`)
    const scope = new DisposeScope()
    try {
      return volumeOf(oc!, scope, h.table.get<OccShape>(handle))
    } finally {
      scope.dispose()
    }
  }

  function runReport(faces?: string[]): BuildResponse {
    const doc = structuredClone(REPORT_DOC)
    const features = doc.features as Array<Record<string, unknown>>
    if (faces !== undefined) {
      const move = features.find((f) => f.id === MOVE_ID)!
      move.move_face = { ...(move.move_face as Record<string, unknown>), faces }
    }
    return h.run(doc)
  }

  function reportPicks(): string[] {
    const features = REPORT_DOC.features as Array<Record<string, unknown>>
    const move = features.find((f) => f.id === MOVE_ID)!
    return (move.move_face as { faces: string[] }).faces
  }

  it('the report document builds the 23 x 39 x 29 box through the live cap hand-off', () => {
    const r = runReport()
    expect(h.res(r, MOVE_ID).status, String(h.res(r, MOVE_ID).exception ?? '')).toBe('ok')
    const part = h.part(r, PART_ID) as PartView
    const volume = volumeAfter(r, MOVE_ID)
    expect(Math.abs(volume - 26013) / 26013).toBeLessThan(1e-6)
    expect(faceQueries(part)).toHaveLength(6)
    expect(((part.vertices as unknown[]) ?? [])).toHaveLength(8)
    const box = bbox(part)
    const want = [-11.5, -2, -19.5, 11.5, 27, 19.5]
    for (let i = 0; i < 6; i++) expect(box[i]).toBeCloseTo(want[i], 4)
  })

  it('a legacy cap pick and the same pick re-picked live build the same body', () => {
    // Build the box without the move to read the bottom cap's current query.
    const baseDoc = structuredClone(REPORT_DOC)
    ;(baseDoc.features as Array<Record<string, unknown>>).pop()
    const base = h.run(baseDoc)
    // The top-plane sketch extrudes along +Y, so the bottom cap looks along -Y.
    const liveBottom = faceQueryWhere(base.bodies, (n) =>
      Math.abs(n[0]) < 1e-6 && Math.abs(n[1] + 1) < 1e-6 && Math.abs(n[2]) < 1e-6)
    const stored = reportPicks()
    expect(stored[BOTTOM_PICK]).toContain('u|u_93fe1154aae79595')
    const livePicks = [...stored]
    livePicks[BOTTOM_PICK] = liveBottom
    expect(livePicks[BOTTOM_PICK]).not.toBe(stored[BOTTOM_PICK])

    const legacyRun = runReport()
    const liveRun = runReport(livePicks)
    expect(h.res(liveRun, MOVE_ID).status).toBe('ok')
    expect(volumeAfter(liveRun, MOVE_ID)).toBeCloseTo(volumeAfter(legacyRun, MOVE_ID), 6)
    const legacyPart = h.part(legacyRun, PART_ID) as PartView
    const livePart = h.part(liveRun, PART_ID) as PartView
    expect(faceQueries(livePart)).toHaveLength(faceQueries(legacyPart).length)
    const uuids = (part: PartView): string[] =>
      faceQueries(part).map(uuidOf).filter((u): u is string => u !== null).sort()
    expect(uuids(livePart)).toEqual(uuids(legacyPart))
  })

  it('the five picks reversed build the same volume, face count and UUID set', () => {
    const forward = runReport()
    const reverse = runReport([...reportPicks()].reverse())
    expect(h.res(reverse, MOVE_ID).status).toBe('ok')
    expect(volumeAfter(reverse, MOVE_ID)).toBeCloseTo(volumeAfter(forward, MOVE_ID), 6)
    expect(faceQueries(h.part(reverse, PART_ID) as PartView))
      .toHaveLength(faceQueries(h.part(forward, PART_ID) as PartView).length)
    const uuids = (part: PartView): string[] =>
      faceQueries(part).map(uuidOf).filter((u): u is string => u !== null).sort()
    expect(uuids(h.part(reverse, PART_ID) as PartView))
      .toEqual(uuids(h.part(forward, PART_ID) as PartView))
  })

  it('a resolved-but-nameless pick still takes the set path', () => {
    // A true pre-split body: every face but the top has a live UUID. The top
    // resolves by its ancestry and classifiers, yet carries no construction
    // name, so the leaf can only apply the group as one set on the original
    // body. The top and bottom are not adjacent, so both moves apply.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const faces = canonicalFaces(oc!, scope, box)
      const centroidZ = faces.map((f) => faceCentroid(oc!, scope, f)[2])
      const topIndex = centroidZ.findIndex((z) => Math.abs(z - 10) < 1e-9)
      const bottomIndex = centroidZ.findIndex((z) => Math.abs(z) < 1e-9)
      expect(topIndex).toBeGreaterThanOrEqual(0)
      expect(bottomIndex).toBeGreaterThanOrEqual(0)
      const face_uuids = faces.map((_, i) => (i === topIndex ? null : `f${i}`))
      const partStore: Record<string, PartSolid> = {
        body_b: {
          id: 'body_b', created_by: 'ex1', modified_by: [],
          shape: table.register(box, 'ex1'), sketch_id: 'sk',
          brep_diff: null, profile_queries: [], face_uuids,
        },
      }
      const namelessTop = makeAncestryQuery(
        [ref('ex1'), ref('body_b'), ref('cls_zp')], 'flatface')
      const bottom = makeAncestryQuery([constructionUuidToken(`f${bottomIndex}`)], 'flatface')
      const res = solveMoveFace(
        oc!, scope, table,
        { id: 'mf1', move_face: { faces: [namelessTop, bottom], distance: 2 } },
        new Repository(), partStore,
      )
      expect(res.status).toBe('ok')
      const moved = table.get<OccShape>(partStore.body_b.shape!)
      expect(volumeOf(oc!, scope, moved)).toBeCloseTo(1400, 6)
    } finally {
      scope.dispose()
    }
  })

  it('adjacent picks apply together on the direct route, not through a set refusal', () => {
    const base = h.run(lProfileSpec())
    expect(h.res(base, 'ex1').status).toBe('ok')
    const left = faceQueryWhere(base.bodies, (n, c) =>
      Math.abs(n[0] + 1) < 1e-6 && Math.abs(c[0]) < 1e-6)
    // The front-plane sketch's second coordinate is world Y; the extrude is +Z.
    const top = faceQueryWhere(base.bodies, (n, c) =>
      Math.abs(n[1] - 1) < 1e-6 && Math.abs(c[1] - 30) < 1e-6)
    const right = faceQueryWhere(base.bodies, (n, c) =>
      Math.abs(n[0] - 1) < 1e-6 && Math.abs(c[0] - 30) < 1e-6)

    // The direct route is one simultaneous operation, so the picks that share
    // an edge all apply. The old one-boolean set path refused the adjacent pair
    // by name; that guard is gone with the slab route.
    const grouped = h.run({ features: [
      ...lProfileSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [left, top, right], distance: 5 } },
    ] })
    const res = h.res(grouped, 'mf1')
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    expect(((res.failed_faces as string[] | undefined) ?? [])).toEqual([])
    // All three faces grew by the same distance, so the volume grew.
    expect(volumeAfter(grouped, 'mf1', 'body_ex1')).toBeGreaterThan(volumeAfter(base, 'ex1', 'body_ex1'))
  }, 60000)
})
