// @vitest-environment node
//
// Gated real-OCC end-to-end test for the loft LEAF (features/loft.ts): the
// profile resolution through a Repository's sketch entries, the OCC ThruSections
// call, the construction naming of caps and bands, the body-store update and the
// refusal paths. The OCCT call/history facts themselves are pinned by
// occ/__tests__/thruSectionsProbeReal.test.ts; here the leaf is driven with two
// solved-sketch entries registered the way a real solve leaves them.
//
// Sections are named by their whole-sketch refs (`@sk1`), and the profiles carry
// entity ids, so the test does not depend on any face enumeration order beyond
// the body it builds itself.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces, canonicalEdges } from '../../occ/bodyNames'
import { makeBoxAt } from '../../occ/primitives'
import { registerSplitBodies } from '../bodySplit'
import { Repository, makeAncestryQuery, constructionUuidToken, ref } from '../../query'
import { mintFaceUuid, loftFacePath, splitFacePath } from '../../constructionName'
import { solveLoft } from '../loft'
import type { LoftFeature } from '@/types/cad'
import type { LoopEdge } from '../../profileLoops'
import type { PlaneLike } from '../shared/planes'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const squareLoop = (size: number, offset = 0): LoopEdge[] => [
  { id: 'e1', kind: 'line', start: [offset, offset], end: [offset + size, offset] },
  { id: 'e2', kind: 'line', start: [offset + size, offset], end: [offset + size, offset + size] },
  { id: 'e3', kind: 'line', start: [offset + size, offset + size], end: [offset, offset + size] },
  { id: 'e4', kind: 'line', start: [offset, offset + size], end: [offset, offset] },
]

const planeAt = (z: number): PlaneLike => ({
  origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
})

/** A solved-sketch entry: the plane transform plus one closed region. */
function registerSketch(repo: Repository, sketchId: string, z: number, size: number, offset = 0): void {
  repo.register('_pt_' + sketchId, planeAt(z))
  repo.register('_topo_' + sketchId, {
    surfaces: [{ query: makeAncestryQuery([ref(sketchId + '/e1')], 'flatface'), boundary: squareLoop(size, offset) }],
  })
}

const loftFeature = (loft: Partial<LoftFeature['loft']>): LoftFeature => ({
  id: 'lo1', kind: 'loft', label: 'Loft',
  loft: { profiles: ['@sk1', '@sk2'], ruled: true, operation: 'new', ...loft },
})

describe.skipIf(!oc)('solveLoft leaf (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  it('lofts a 10x10 to a 6x6 section 10 apart into the frustum', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      const bodyStore: Record<string, Body> = {}
      const res = solveLoft(occ, scope, table, loftFeature({}), repo, bodyStore)
      expect(res.status).toBe('ok')
      expect(res.body_ids).toEqual(['body_lo1'])
      const body = bodyStore.body_lo1
      expect(body.modified_by).toEqual([])
      const shape = table.get<OccShape>(body.shape!)
      // h/3*(A1 + A2 + sqrt(A1*A2)) = 10/3*(100 + 36 + 60).
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(653.3333333333334, 6)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(6)
      expect(canonicalEdges(occ, scope, shape)).toHaveLength(12)
    } finally {
      scope.dispose()
    }
  })

  it('names both caps and every band by construction', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      const bodyStore: Record<string, Body> = {}
      solveLoft(occ, scope, table, loftFeature({}), repo, bodyStore)
      const uuids = bodyStore.body_lo1.face_uuids ?? []
      // Every result face carries a UUID.
      expect(uuids.every((u) => typeof u === 'string' && u.length > 0)).toBe(true)
      // The start cap is the first profile's, the end cap the last's.
      expect(uuids).toContain(mintFaceUuid(loftFacePath('lo1', 'cap', 'start')))
      expect(uuids).toContain(mintFaceUuid(loftFacePath('lo1', 'cap', 'end')))
      // Four ruled bands, one per boundary edge of the first section: the
      // single band between two sections keeps the base path (no split suffix).
      for (const eid of ['e1', 'e2', 'e3', 'e4']) {
        expect(uuids).toContain(mintFaceUuid(loftFacePath('lo1', 'side', `s0|${eid}`)))
      }
      // The section's ancestry tokens ride the cap: the sketch entity ref.
      expect(bodyStore.body_lo1.face_ancestry?.[mintFaceUuid(loftFacePath('lo1', 'cap', 'start'))]).toBeTruthy()
    } finally {
      scope.dispose()
    }
  })

  it('numbers the split children of a two-band edge bottom-up and keeps them stably named', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const build = (midSize: number): string[] => {
        const repo = new Repository()
        registerSketch(repo, 'sk1', 0, 10)
        registerSketch(repo, 'sk2', 5, midSize)
        registerSketch(repo, 'sk3', 10, 8)
        const bodyStore: Record<string, Body> = {}
        const res = solveLoft(
          occ, scope, table,
          loftFeature({ profiles: ['@sk1', '@sk2', '@sk3'] }),
          repo, bodyStore,
        )
        expect(res.status).toBe('ok')
        const uuids = bodyStore.body_lo1.face_uuids ?? []
        // A ruled loft between three sections has two bands per edge: the FIRST
        // section's edge claims both, ordered bottom-up as split children.
        for (const idx of [0, 1]) {
          expect(uuids).toContain(mintFaceUuid(splitFacePath(mintFaceUuid(loftFacePath('lo1', 'side', 's0|e1')), idx)))
        }
        return uuids.filter((u): u is string => typeof u === 'string')
      }
      const at16 = build(16)
      // The same source sections mint the same band names whatever the middle
      // section's size: the names are construction, not geometry.
      expect(at16).toEqual(build(14))
    } finally {
      scope.dispose()
    }
  })

  it('a smooth loft through three sections is one face per band and keeps the caps', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 5, 16)
      registerSketch(repo, 'sk3', 10, 8)
      const bodyStore: Record<string, Body> = {}
      const res = solveLoft(
        occ, scope, table,
        loftFeature({ profiles: ['@sk1', '@sk2', '@sk3'], ruled: false }),
        repo, bodyStore,
      )
      expect(res.status).toBe('ok')
      const shape = table.get<OccShape>(bodyStore.body_lo1.shape!)
      // One face per boundary edge plus the two caps: the surface runs through
      // every section instead of banding between them.
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(6)
      // The smooth surface bulges past the ruled one (1606.67). Its exact volume
      // depends on how the section wires are parameterized (the wire's seam and
      // edge order feed the spline), so this pins the value for the deterministic
      // wires this test builds; thruSectionsProbeReal.test.ts pins the raw OCCT
      // value for its own wire construction.
      const smooth = volumeOf(occ, scope, shape)
      expect(smooth).toBeGreaterThan(1606.6666666666667)
      expect(smooth).toBeCloseTo(1921.7370065516336, 4)
    } finally {
      scope.dispose()
    }
  })

  it('refuses fewer than two profiles, naming the rule', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      expect(() =>
        solveLoft(occ, scope, table, loftFeature({ profiles: ['@sk1'] }), repo, {}),
      ).toThrow(/at least two profiles/)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a profile that resolves to no geometry, naming it', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      // A sketch entry with no closed region: the profile exists but builds
      // nothing.
      repo.register('_pt_sk3', planeAt(20))
      repo.register('_topo_sk3', { surfaces: [] })
      expect(() =>
        solveLoft(occ, scope, table, loftFeature({ profiles: ['@sk1', '@sk3'] }), repo, {}),
      ).toThrow(/profiles\[1\].*no closed region/)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a section that resolves to two separate regions, naming the count', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      repo.register('_pt_sk3', planeAt(20))
      repo.register('_topo_sk3', {
        surfaces: [
          { query: makeAncestryQuery([ref('sk3/e1')], 'flatface'), boundary: squareLoop(4) },
          { query: makeAncestryQuery([ref('sk3/e5')], 'flatface'), boundary: squareLoop(4, 8) },
        ],
      })
      expect(() =>
        solveLoft(occ, scope, table, loftFeature({ profiles: ['@sk1', '@sk3'] }), repo, {}),
      ).toThrow(/2 separate regions/)
    } finally {
      scope.dispose()
    }
  })

  it('a stale profile ref is refused by name, not silently dropped', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      const stale = makeAncestryQuery([ref('sk_dead/e1')], 'flatface')
      expect(() =>
        solveLoft(occ, scope, table, loftFeature({ profiles: ['@sk1', stale] }), repo, {}),
      ).toThrow(/profiles\[1\]/)
    } finally {
      scope.dispose()
    }
  })

  it('adds a loft onto an existing box body through the shared body operation', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 6, 6)
      registerSketch(repo, 'sk2', 12, 3)
      const bodyStore: Record<string, Body> = {}
      const box = scope.track(makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10))
      registerSplitBodies(occ, scope, table, bodyStore, box, {
        id: 'body_base', createdBy: 'seed', sketchId: 'sk_seed', profileQueries: [],
      })
      // The loft starts inside the box (its 6x6 base section at z=6 is inside the
      // 10-cube) and pokes out of the top: a volumetric overlap, no coincident
      // faces, so the fuse has nothing tangent to resolve.
      const res = solveLoft(
        occ, scope, table,
        { id: 'lo2', kind: 'loft', loft: { profiles: ['@sk1', '@sk2'], ruled: true, operation: 'add', merge_target: '@body_base' } },
        repo, bodyStore,
      )
      expect(res.status).toBe('ok')
      expect(res.body_id).toBe('body_base')
      // The union is the box plus the loft above z=10: the interpolated section
      // there is 4x4, so 10/3... = 2/3*(16 + 9 + 12) = 24.667.
      const fused = table.get<OccShape>(bodyStore.body_base.shape!)
      expect(volumeOf(occ, scope, fused)).toBeCloseTo(1000 + (2 / 3) * 37, 6)
      expect(bodyStore.body_base.modified_by).toContain('lo2')
    } finally {
      scope.dispose()
    }
  })

  it('resolves faces through the construction UUID queries a solve emits', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = new Repository()
      registerSketch(repo, 'sk1', 0, 10)
      registerSketch(repo, 'sk2', 10, 6)
      const bodyStore: Record<string, Body> = {}
      solveLoft(occ, scope, table, loftFeature({}), repo, bodyStore)
      const uuid = bodyStore.body_lo1.face_uuids?.[0]
      expect(uuid).toBeTruthy()
      // The minted UUID round-trips through the query wire form the viewport
      // mints for a picked face.
      const query = makeAncestryQuery([constructionUuidToken(uuid!)], 'flatface')
      expect(query).toContain('@u|' + uuid)
    } finally {
      scope.dispose()
    }
  })
})
