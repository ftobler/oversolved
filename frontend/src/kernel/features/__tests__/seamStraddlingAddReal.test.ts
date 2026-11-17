// @vitest-environment node
//
// A tool that straddles a revolved body's seam, through the two consumers that
// reach it: a feature-subject circular pattern whose source add straddles the
// seam, and an explicit boolean union of the same ribs. The fuse into the
// already-ribbed body is the failing step (bugreports/20261115_2016_boolean_fail.md);
// the seam-aware fuse in `booleans.ts` is what makes it sound.
//
// The funnel is a fit-spline neck and cone revolved 360 degrees about +Y, so the
// seam meridian lies in the front sketch plane (z = 0). The rib is a box centred
// on that plane, so its add covers part of the seam.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { volumeOf } from '../../occ/volume'
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

function revolve(): Dict {
  return {
    id: 'rv1', kind: 'revolve',
    revolve: { sketch: '@sk1', angle: 360, axis: '@skax/ax', operation: 'new' },
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
      funnelSketch(plane), axisSketch(), revolve(),
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
      funnelSketch('@builtin_plane_front'), axisSketch(), revolve(),
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

describe.skipIf(!oc || !solveBytes)('a seam-straddling rib through the real kernel', () => {
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

  function volumeAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const body = bodyAt(r, featureId, bodyId)
    if (body?.shape === null || body?.shape === undefined) throw new Error(`no body ${bodyId} at ${featureId}`)
    const scope = new DisposeScope()
    try {
      return volumeOf(occ, scope, h.table.get<OccShape>(body.shape))
    } finally {
      scope.dispose()
    }
  }

  function faceCountAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const body = bodyAt(r, featureId, bodyId)
    const scope = new DisposeScope()
    try {
      const shape = h.table.get<OccShape>(body!.shape!)
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      let count = 0
      for (; exp.More(); exp.Next()) count++
      return count
    } finally {
      scope.dispose()
    }
  }

  /** Every face of the body named, and no UUID minted twice: the seam recovery
   *  composes its two fuses' origin tables back onto the caller's target and
   *  tool faces, and a gap there leaves faces unnamed or a UUID claimed twice. */
  function expectEveryFaceNamed(r: BuildResponse, featureId: string, bodyId: string): void {
    const uuids = (bodyAt(r, featureId, bodyId)?.face_uuids ?? []).filter((u): u is string => u !== null)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(uuids.length).toBe(faceCountAt(r, featureId, bodyId))
  }

  it('fuses every copy of a pattern whose source add straddles the seam', () => {
    const r = h.run(patternDoc(0, 6))
    const res = h.res(r, 'cp1')
    // No copy refused: a partial would carry the failing copy in `exception`.
    expect(res.exception).toBeUndefined()
    expect(res.status).toBe('ok')
    // The source body plus five copies, all in the one body the add shaped.
    const faces = faceCountAt(r, 'cp1', 'body_rv1')
    expect(faces).toBeGreaterThan(16)
    expectEveryFaceNamed(r, 'cp1', 'body_rv1')
    // Every copy adds the same material as the first.
    const v1 = volumeAt(h.run(patternDoc(0, 1)), 'cp1', 'body_rv1')
    const v2 = volumeAt(h.run(patternDoc(0, 2)), 'cp1', 'body_rv1')
    const v6 = volumeAt(r, 'cp1', 'body_rv1')
    const firstCopy = v2 - v1
    expect(firstCopy).toBeGreaterThan(0)
    expect(Math.abs((v6 - v2) - 4 * firstCopy)).toBeLessThan(1e-3 * (v6 - v1))
  })

  it('leaves the seam-off-centreline pattern exactly as it was', () => {
    const onSeamRun = h.run(patternDoc(0, 6))
    const offSeamRun = h.run(patternDoc(45, 6))
    expect(h.res(onSeamRun, 'cp1').exception).toBeUndefined()
    expect(h.res(offSeamRun, 'cp1').exception).toBeUndefined()
    const onSeam = volumeAt(onSeamRun, 'cp1', 'body_rv1')
    const offSeam = volumeAt(offSeamRun, 'cp1', 'body_rv1')
    // The same solid, rotated: only the seam's angular position differs. The
    // two builds split the B-spline cone into different faces, so their volume
    // reads differ by that face set's read error (about 2e-3 measured).
    expect(Math.abs(onSeam - offSeam)).toBeLessThan(1e-2 * Math.abs(offSeam))
  })

  it('fuses a rib that straddles a straight cylinder seam, then another rib', () => {
    // The straight-seam branch: a cylinder's seam is a line, so its split plane
    // comes from the surface's own axis rather than from three edge samples.
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        // A solid cylinder r10, y 0..20, revolved about +Y with its seam in z = 0.
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
        axisSketch(),
        { id: 'rv1', kind: 'revolve', revolve: { sketch: '@skc', angle: 360, axis: '@skax/ax', operation: 'new' } },
        // skb1 straddles the seam plane (z = 0), skb2 sits 90 degrees away.
        {
          id: 'skb1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [
            { id: 'b1', kind: 'line' }, { id: 'b2', kind: 'line' },
            { id: 'b3', kind: 'line' }, { id: 'b4', kind: 'line' },
          ],
          initial: {
            b1: [8, 2, 14, 2], b2: [14, 2, 14, 6], b3: [14, 6, 8, 6], b4: [8, 6, 8, 2],
          },
          constraints: [],
        },
        {
          id: 'ex1', kind: 'extrude',
          extrude: { sketch: '@skb1', distance: 4, direction: 'symmetric', operation: 'add', merge_target: '@body_rv1' },
        },
        {
          id: 'skb2', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [
            { id: 'd1', kind: 'line' }, { id: 'd2', kind: 'line' },
            { id: 'd3', kind: 'line' }, { id: 'd4', kind: 'line' },
          ],
          initial: {
            d1: [8, 12, 14, 12], d2: [14, 12, 14, 16], d3: [14, 16, 8, 16], d4: [8, 16, 8, 12],
          },
          constraints: [],
        },
        {
          id: 'ex2', kind: 'extrude',
          extrude: { sketch: '@skb2', distance: 4, direction: 'symmetric', operation: 'add', merge_target: '@body_rv1' },
        },
      ],
    })
    expect(h.res(r, 'ex1').exception).toBeUndefined()
    expect(h.res(r, 'ex2').exception).toBeUndefined()
    expect(h.res(r, 'ex2').status).toBe('ok')
    expectEveryFaceNamed(r, 'ex2', 'body_rv1')
  })

  it('unions the same six ribs into the revolve as the reported document does', () => {
    const r = h.run(unionDoc())
    expect(h.res(r, 'b1').status).toBe('ok')
    expect(h.res(r, 'b1').exception).toBeUndefined()
    // The ribs are consumed by the union; one body survives.
    expect(bodyAt(r, 'b1', 'body_rv1')).toBeDefined()
    expect(bodyAt(r, 'b1', 'body_ex1')).toBeUndefined()
    expectEveryFaceNamed(r, 'b1', 'body_rv1')
    // The union result and the feature pattern's result are the same solid.
    const unionVolume = volumeAt(r, 'b1', 'body_rv1')
    const patternVolume = volumeAt(h.run(patternDoc(0, 6)), 'cp1', 'body_rv1')
    expect(Math.abs(unionVolume - patternVolume)).toBeLessThan(1e-3 * Math.abs(patternVolume))
  })
})
