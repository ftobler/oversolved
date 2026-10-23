// @vitest-environment node
//
// Gated real-OCC test for the construction-name threading
// (query-naming-by-construction.md): a face UUID is carried across a boolean and
// across a fillet by OCC subshape identity (Modified/IsSame), NOT geometry.
// Asserts that faces the op leaves untouched keep their exact minted UUID, and
// that a fillet mints a role=fillet UUID slotted by the filleted edge's UUID.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { extrudeProfileWithLineage } from '../prismLineage'
import { booleanWithDiff } from '../booleans'
import { applyFilletWithLineage } from '../edgeModifier'
import { transferBooleanNames } from '../../features/booleanLineage'
import { solveBoolean } from '../../features/boolean'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { Repository } from '../../query'
import { canonicalFaces, namesToArray } from '../bodyNames'
import type { SubShapeMap } from '../subshapeIdentity'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Body } from '../../types3d'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'
import type { Vec3 } from '../primitives'
import {
  mintFaceUuid,
  sideFacePath,
  capFacePath,
  filletFacePath,
  toolCopyFacePath,
} from '../../constructionName'

const oc = await loadOcc()
const solveBytes = loadSolver()

function planeAt(z: number): PlaneLike {
  return { origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

function square(x0: number, y0: number, size: number): LoopEdge[][] {
  const c: [number, number][] = [
    [x0, y0],
    [x0 + size, y0],
    [x0 + size, y0 + size],
    [x0, y0 + size],
  ]
  return [c.map((start, i) => ({ kind: 'line', id: `l${i}`, start, end: c[(i + 1) % c.length] }))]
}

function edgesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  return out
}

describe.skipIf(!oc)('construction-name threading through ops (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('carries a target face UUID across a fuse by subshape identity', () => {
    const scope = new DisposeScope()
    try {
      // A 10x10x10 base box (e1) and a 6x6x5 bump (e2) fused onto its top face.
      const base = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')
      const bump = extrudeProfileWithLineage(occ, scope, square(2, 2, 6), planeAt(10), [0, 0, 1] as Vec3, 5, 'sk2', 'e2')

      const { shape: fused, faceOrigin } = booleanWithDiff(occ, scope, base.solid, bump.solid, 'fuse')
      const names = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: null,
      })
      const carried = new Set(names.faceNames.values())

      // The base box's bottom cap and 4 side walls are untouched by the fuse, so
      // their exact minted UUIDs must survive.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)
      for (let i = 0; i < 4; i++) {
        expect(carried.has(mintFaceUuid(sideFacePath('e1', `sk1/l${i}`)))).toBe(true)
      }
      // The bump's own side walls (from e2) are carried too.
      for (let i = 0; i < 4; i++) {
        expect(carried.has(mintFaceUuid(sideFacePath('e2', `sk2/l${i}`)))).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })

  it('re-mints a KEPT tool\'s UUIDs onto the target so the two never collide', () => {
    // `keep_tools` leaves the tool body in the store still carrying its own face
    // UUIDs. Handing them to the target verbatim put one UUID on two live faces,
    // and the resolver's UUID tier then refused every pick of either with
    // "collision by construction" (bugreports/20260902_2256_face_not_extruding).
    const scope = new DisposeScope()
    try {
      const base = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')
      const bump = extrudeProfileWithLineage(occ, scope, square(2, 2, 6), planeAt(10), [0, 0, 1] as Vec3, 5, 'sk2', 'e2')
      const { shape: fused, faceOrigin } = booleanWithDiff(occ, scope, base.solid, bump.solid, 'fuse')

      const kept = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: 'bool1',
      })
      const carried = new Set(kept.faceNames.values())

      // Not one of the surviving tool's own UUIDs appears on the target.
      for (const toolUuid of bump.faceNames.values()) {
        expect(carried.has(toolUuid)).toBe(false)
      }
      // They are re-minted, not dropped: each tool face still has a stable
      // identity on the target, derived from the tool's UUID and this boolean.
      for (let i = 0; i < 4; i++) {
        const toolUuid = mintFaceUuid(sideFacePath('e2', `sk2/l${i}`))
        expect(carried.has(mintFaceUuid(toolCopyFacePath(toolUuid, 'bool1')))).toBe(true)
      }
      // The target's own faces are untouched by the re-mint.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)

      // A consuming boolean keeps the verbatim carry-over: its tool is gone, so
      // the inherited UUID is unique and re-minting would only churn it.
      const consumed = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: null,
      })
      const consumedCarried = new Set(consumed.faceNames.values())
      expect(consumedCarried.has(mintFaceUuid(sideFacePath('e2', 'sk2/l0')))).toBe(true)

      // Ancestry follows the re-minted UUID -- and carries the tool face's own
      // tokens, not an empty list. Keying that lookup on the re-minted UUID
      // instead of the source silently yields `[]`, which leaves the ancestral
      // fallback tier with nothing and sends the face to the body-wide
      // profile_queries bucket (builder.ts), so `toBeDefined` is not enough.
      let withTokens = 0
      for (const toolUuid of bump.faceNames.values()) {
        const reminted = mintFaceUuid(toolCopyFacePath(toolUuid, 'bool1'))
        if (!carried.has(reminted)) continue  // face consumed by the fuse
        expect(kept.faceAncestry[reminted]).toEqual(bump.faceAncestry[toolUuid])
        if ((kept.faceAncestry[reminted] ?? []).length > 0) withTokens++
      }
      // And at least one of them really has tokens -- the wrong lookup key
      // satisfies the equality above only by making every list empty.
      expect(withTokens).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('fillet keeps untouched face UUIDs and mints a role=fillet UUID', () => {
    const scope = new DisposeScope()
    try {
      const box = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')

      // Pick one named edge to fillet.
      const edges = edgesOf(occ, scope, box.solid)
      let picked: OccShape | null = null
      let pickedUuid = ''
      for (const e of edges) {
        const u = box.edgeNames.get(e as OccSubShape)
        if (u) {
          picked = e
          pickedUuid = u
          break
        }
      }
      expect(picked).not.toBeNull()

      const res = applyFilletWithLineage(occ, scope, box.solid, 1.0, [picked as OccShape], {
        createdBy: 'f1',
        faceNames: box.faceNames,
        edgeNames: box.edgeNames,
        faceAncestry: box.faceAncestry,
        edgeAncestry: box.edgeAncestry,
        capAncestry: box.capAncestry,
      })
      expect(res.success).toBe(true)
      expect(res.names).not.toBeNull()
      const carried = new Set(res.names!.faceNames.values())

      // The generated fillet face is named role=fillet slotted by the edge UUID.
      expect(carried.has(mintFaceUuid(filletFacePath('f1', pickedUuid)))).toBe(true)
      // A box face not adjacent to the filleted edge keeps its UUID; the bottom
      // cap (start) survives every single-edge fillet.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})

/** The face UUIDs a `names` map carries, read as an array aligned to `shape`. */
function faceUuidsOf(
  occ: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceNames: SubShapeMap<string>,
): string[] {
  return namesToArray(canonicalFaces(occ, scope, shape), faceNames) as string[]
}

describe.skipIf(!oc)('boolean clearance naming (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('hole walls carry the tool face UUIDs equally at clearance 0 and +0.1', () => {
    const toolSideUuids = [0, 1, 2, 3].map((i) => mintFaceUuid(sideFacePath('e_u', `sk_u/l${i}`)))

    const targetFaceUuids = (clearance: number): string[] => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const target = extrudeProfileWithLineage(
          occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk_t', 'e_t',
        )
        const tool = extrudeProfileWithLineage(
          occ, scope, square(3, 3, 4), planeAt(-1), [0, 0, 1] as Vec3, 12, 'sk_u', 'e_u',
        )
        const store: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'e_t', modified_by: [], sketch_id: 'sk_t',
            shape: table.register(target.solid, 'e_t'), brep_diff: null, profile_queries: [],
            face_uuids: faceUuidsOf(occ, scope, target.solid, target.faceNames),
          },
          body_u: {
            id: 'body_u', created_by: 'e_u', modified_by: [], sketch_id: 'sk_u',
            shape: table.register(tool.solid, 'e_u'), brep_diff: null, profile_queries: [],
            face_uuids: faceUuidsOf(occ, scope, tool.solid, tool.faceNames),
          },
        }
        solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance } },
          new Repository(), store,
        )
        return (store.body_t.face_uuids ?? []) as string[]
      } finally {
        scope.dispose()
      }
    }

    const atZero = targetFaceUuids(0)
    const atTenth = targetFaceUuids(0.1)
    // The four hole walls survive identically at both clearances: the grown face
    // carries the source face's UUID, so a downstream pick is stable.
    for (const u of toolSideUuids) {
      expect(atZero).toContain(u)
      expect(atTenth).toContain(u)
    }
  })
})

function rectSketch(sketchId: string, w: number, h: number, opts?: { offsetX?: number; offsetY?: number }) {
  const ox = opts?.offsetX ?? 0
  const oy = opts?.offsetY ?? 0
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
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

describe.skipIf(!oc || !solveBytes)('clearance naming through the builder (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('a fillet picked on a hole-wall edge at clearance 0 still solves at +0.1', () => {
    const features = [
      rectSketch('sk1', 20, 20),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      rectSketch('sk2', 6, 6, { offsetX: 7, offsetY: 7 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 20, direction: 'symmetric', operation: 'new' },
    ]
    const baseDoc = {
      version: 1, kind: 'part', features: [
        ...features,
        { id: 'bool1', kind: 'boolean', boolean: { operation: 'subtract', target: '@ex1', tools: ['@ex2'], clearance: 0 } },
      ],
    }
    const r0 = h.run(baseDoc)
    expect(h.res(r0, 'bool1').status).toBe('ok')

    // The boolean created the hole-rim edges; pick one by the persistent query it
    // emitted, exactly as a user pick would.
    const body = (r0.bodies as Record<string, { edge_queries?: string[]; edge_created_by?: string[] }>).body_ex1
    const idx = (body.edge_created_by ?? []).findIndex((cb) => cb === 'bool1')
    expect(idx, 'the boolean should create hole-rim edges').toBeGreaterThanOrEqual(0)
    const edgeQuery = body.edge_queries![idx]

    const withClearance = (clearance: number) => ({
      version: 1, kind: 'part', features: [
        ...features,
        { id: 'bool1', kind: 'boolean', boolean: { operation: 'subtract', target: '@ex1', tools: ['@ex2'], clearance } },
        { id: 'fillet1', kind: 'fillet', edges: [edgeQuery], radius: 1 },
      ],
    })

    const r1 = h.run(withClearance(0))
    expect(h.res(r1, 'fillet1').status).toBe('ok')
    // Editing the clearance must not strand the picked edge: the grown hole wall
    // keeps the source face's UUID, so the query resolves again.
    const r2 = h.run(withClearance(0.1), { prevState: r1._build_state })
    expect(h.res(r2, 'fillet1').status).toBe('ok')
  }, 120_000)
})
