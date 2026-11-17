// @vitest-environment node
//
// The seam-straddling add, accepted as a limitation and pinned here.
//
// A tool whose material covers part of a revolved body's seam edge leaves a
// body that validates and has the exact right volume, but every later boolean
// over it returns a BRepCheck-invalid freeform face (reproducer:
// `bugreports/20261115_2016_boolean_fail.md`; measured on OCCT 8.0.1, the pinned
// `frontend/occ.pin.json`). Two consumers reach it: a feature-subject circular
// pattern whose source add straddles the seam, and an explicit union of the
// same ribs.
//
// What was measured, and why the code does not heal it: fusing the tool split
// at the seam plane does produce a body the later booleans accept, but it is
// 68.24 mm3 short (2.2e-3 of the body, Gauss-Kronrod), and the order that keeps
// the exact material is the unusable body again. Re-adding the whole tool
// restores the volume and restores the defect. No construction in this binding
// is both exact and usable, so the boolean keeps the plain (exact) result and
// the refusal names what went wrong.
//
// These tests pin the current outcomes so a kernel or binding change that fixes
// the family breaks them loudly, and so the controls that DO work stay working.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { booleanWithDiff } from '../../occ/booleans'
import { volumeForMeasure } from '../../occ/volume'
import { splitPatternDef } from '@/utils/core/patternSplit'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** The reported funnel wall: neck r 15.5..17 to y 24, a fit-spline cone out to
 *  r 70 at y 95, a 1.5 mm rim, and a fit-spline skirt back down. The profile is
 *  left free (the subject here is the boolean, not the sketch), so the sketch
 *  reports underconstrained; every assertion below is about a feature status. */
function funnelSketch(plane: string): Dict {
  return {
    id: 'sk1', kind: 'sketch', label: 'Funnel wall', plane,
    entities: [
      { id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' },
      { id: 's1', kind: 'fit_spline' }, { id: 'l3', kind: 'line' },
      { id: 's2', kind: 'fit_spline' }, { id: 'l4', kind: 'line' },
    ],
    initial: {
      l1: [15.5, 0, 17, 0], l2: [17, 0, 17, 24],
      s1: [17, 24, 40, 50, 70, 95], l3: [70, 95, 70, 96.5],
      s2: [70, 96.5, 40, 52, 15.5, 26], l4: [15.5, 26, 15.5, 0],
    },
    constraints: [],
  }
}

/** The revolve axis: the front plane's +Y line through the origin. */
function axisSketch(): Dict {
  return {
    id: 'skax', kind: 'sketch', label: 'Axis', plane: '@builtin_plane_front',
    entities: [{ id: 'ax', kind: 'line' }],
    initial: { ax: [0, 0, 0, 100] },
    constraints: [],
  }
}

/** The rib: a 13 x 6 box from (17, 24), centred on z = 0 by the symmetric
 *  extrusion, so its add covers part of the revolve's seam. */
function ribSketch(): Dict {
  return {
    id: 'sk3', kind: 'sketch', label: 'Rib', plane: '@builtin_plane_front',
    entities: [
      { id: 'r1', kind: 'line' }, { id: 'r2', kind: 'line' },
      { id: 'r3', kind: 'line' }, { id: 'r4', kind: 'line' },
    ],
    initial: {
      r1: [17, 24, 30, 24], r2: [30, 24, 30, 30],
      r3: [30, 30, 17, 30], r4: [17, 30, 17, 24],
    },
    constraints: [],
  }
}

/** A rotated plane about +Y: the revolve built on it has its seam rotated with
 *  it, which moves the seam off the rib's centreline. */
function rotatedPlane(angle: number): Dict {
  return {
    id: 'pl1', kind: 'plane', label: 'Rotated',
    definition: {
      mode: 'origin_rotation', plane: '@builtin_plane_front',
      origin: [0, 0, 0], rotation_axis: 'y', rotation_angle: angle,
    },
  }
}

function revolve(sketch: string): Dict {
  return {
    id: 'rv1', kind: 'revolve',
    revolve: { sketch, angle: 360, axis: '@skax/ax', operation: 'new' },
  }
}

/** A rectangle sketch from two corners. */
function boxSketch(id: string, x0: number, y0: number, x1: number, y1: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [
      { id: 'q1', kind: 'line' }, { id: 'q2', kind: 'line' },
      { id: 'q3', kind: 'line' }, { id: 'q4', kind: 'line' },
    ],
    initial: {
      q1: [x0, y0, x1, y0], q2: [x1, y0, x1, y1], q3: [x1, y1, x0, y1], q4: [x0, y1, x0, y0],
    },
    constraints: [],
  }
}

/** The reported document's rib as its own body. */
function ribBody(): Dict {
  return {
    id: 'ex1', kind: 'extrude',
    extrude: { sketch: '@sk3', distance: 2.25, direction: 'symmetric', operation: 'new' },
  }
}

function featurePattern(count: number): Dict {
  const { kind, def } = splitPatternDef({
    subject: 'feature', source_features: ['@ex1'], mode: 'circular',
    count, step_angle: 360 / count,
    axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
  })
  return { id: 'cp1', kind, [kind]: def }
}

/** The funnel at `seamAngle`, the rib added, then a circular pattern of it. */
function patternDoc(seamAngle: number, count: number): Record<string, unknown> {
  const plane = seamAngle === 0 ? '@builtin_plane_front' : '@pl1'
  return {
    version: 9, kind: 'part',
    features: [
      ...(seamAngle === 0 ? [] : [rotatedPlane(seamAngle)]),
      funnelSketch(plane), axisSketch(), revolve('@sk1'),
      ribSketch(),
      {
        id: 'ex1', kind: 'extrude',
        extrude: {
          sketch: '@sk3', distance: 2.25, direction: 'symmetric',
          operation: 'add', merge_target: '@body_rv1',
        },
      },
      featurePattern(count),
    ],
  }
}

/** The same funnel, the rib as its own body, a body pattern of six, and one
 *  explicit union of the ribs into the revolve (the reported document). */
function unionDoc(): Record<string, unknown> {
  return {
    version: 9, kind: 'part',
    features: [
      funnelSketch('@builtin_plane_front'), axisSketch(), revolve('@sk1'),
      ribSketch(), ribBody(),
      {
        id: 'cp1', kind: 'circular_pattern',
        circular_pattern: {
          subject: 'body', source_body: '@ex1', count: 6, angle: 360,
          axis_origin: [0, 0, 0], axis_direction: [0, 1, 0], operation: 'new',
        },
      },
      {
        id: 'b1', kind: 'boolean',
        boolean: { operation: 'union', target: '@body_rv1', tools: ['@cp1'] },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('a seam-straddling add (accepted limitation)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function bodyAt(r: BuildResponse, featureId: string, bodyId: string): Body | undefined {
    const store = r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, Body>
    return store[bodyId]
  }

  function shapeAt(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    const body = bodyAt(r, featureId, bodyId)
    if (body?.shape === null || body?.shape === undefined) throw new Error(`no body ${bodyId} at ${featureId}`)
    return h.table.get<OccShape>(body.shape)
  }

  function faceCountAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try {
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(shapeAt(r, featureId, bodyId), E.TopAbs_FACE, E.TopAbs_SHAPE))
      let count = 0
      for (; exp.More(); exp.Next()) count++
      return count
    } finally {
      scope.dispose()
    }
  }

  // Every face of the body named, and no UUID minted twice.
  function expectEveryFaceNamed(r: BuildResponse, featureId: string, bodyId: string): void {
    const uuids = (bodyAt(r, featureId, bodyId)?.face_uuids ?? []).filter((u): u is string => u !== null)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(uuids.length).toBe(faceCountAt(r, featureId, bodyId))
  }

  it('keeps the source add sound and exact, then refuses the first copy', { timeout: 120_000 }, () => {
    const r = h.run(patternDoc(0, 6))
    // The add itself is not the problem: it is sound, named, and exactly the
    // material of the funnel plus the rib (Gauss-Kronrod against the Common).
    const res = h.res(r, 'ex1')
    expect(res.status).toBe('ok')
    expect(res.exception).toBeUndefined()
    expectEveryFaceNamed(r, 'ex1', 'body_rv1')

    const separate = h.run({
      version: 9, kind: 'part',
      features: [
        funnelSketch('@builtin_plane_front'), axisSketch(), revolve('@sk1'),
        ribSketch(), ribBody(),
      ],
    })
    const scope = new DisposeScope()
    try {
      const funnel = shapeAt(separate, 'ex1', 'body_rv1')
      const rib = shapeAt(separate, 'ex1', 'body_ex1')
      const overlap = booleanWithDiff(occ, scope, funnel, rib, 'common').shape
      const expected = volumeForMeasure(occ, scope, funnel) + volumeForMeasure(occ, scope, rib)
        - volumeForMeasure(occ, scope, overlap)
      const source = volumeForMeasure(occ, scope, shapeAt(r, 'ex1', 'body_rv1'))
      expect(Math.abs(source - expected)).toBeLessThan(1e-6 * Math.abs(expected))
    } finally {
      scope.dispose()
    }

    // The copy cannot fuse into that body. This is the limitation: the body
    // above is exact and valid, and the kernel cannot use it any further.
    const pat = h.res(r, 'cp1')
    expect(pat.status).toBe('exception')
    expect(pat.exception).toContain("copy 1")
    expect(pat.exception).toContain('unsound result')
  })

  it('refuses the reported union at the same step', () => {
    const r = h.run(unionDoc())
    expect(h.res(r, 'b1').status).toBe('exception')
    expect(h.res(r, 'b1').exception).toContain('unsound result')
  })

  it('builds the same pattern with the seam off the rib centreline', () => {
    // The user's workaround and the control for the limitation: a 45 degree
    // pre-rotation of the funnel builds at every copy count. This is a build
    // guard only; the two documents are the same solid, so their volumes read
    // apart by the B-spline face-set error (measured about 2e-3).
    for (const count of [2, 6]) {
      const r = h.run(patternDoc(45, count))
      const res = h.res(r, 'cp1')
      expect(res.status).toBe('ok')
      expect(res.exception).toBeUndefined()
      const scope = new DisposeScope()
      try {
        expect(volumeForMeasure(occ, scope, shapeAt(r, 'cp1', 'body_rv1'))).toBeGreaterThan(0)
      } finally {
        scope.dispose()
      }
    }
  })

  it('still fuses a rib that straddles a straight cylinder seam', () => {
    // A cylinder's seam is a line, and this build keeps it through the fuse, so
    // the limitation is specific to the rebuilt freeform face; the add path for
    // the straight case stays working.
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        {
          id: 'skc', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [
            { id: 'c1', kind: 'line' }, { id: 'c2', kind: 'line' },
            { id: 'c3', kind: 'line' }, { id: 'c4', kind: 'line' },
          ],
          initial: {
            c1: [0, 0, 10, 0], c2: [10, 0, 10, 20], c3: [10, 20, 0, 20], c4: [0, 20, 0, 0],
          },
          constraints: [],
        },
        axisSketch(), revolve('@skc'),
        // A rib that is off the seam for the straight case below, and one that
        // straddles it: the box from (8, 2) to (14, 6) crosses z = 0.
        boxSketch('skb', 8, 2, 14, 6),
        {
          id: 'ex1', kind: 'extrude',
          extrude: {
            sketch: '@skb', distance: 4, direction: 'symmetric',
            operation: 'add', merge_target: '@body_rv1',
          },
        },
      ],
    })
    expect(h.res(r, 'ex1').status).toBe('ok')
    expect(h.res(r, 'ex1').exception).toBeUndefined()
    expectEveryFaceNamed(r, 'ex1', 'body_rv1')
  })
})
