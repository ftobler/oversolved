// @vitest-environment node
//
// The third extrude termination: a cut sized from the live bodies instead of
// from the stored `distance`. Real OCC, gated like the other extrude suites.
//
// The base is a 40 x 30 rectangle on the Front plane extruded 10 along the
// Front normal, so the part's thin axis is the cut axis; a 5 x 5 rectangle on
// the same plane is the through cut. The base construction is spelled out in
// every test because a profile on another plane would remove the part's other
// dimension and the volume pin would stop meaning "through the thickness".

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import type { SharedHarness } from '../../occ/sharedHarness'
import { oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec } from '../extrudeRealSupport'

type Dict = Record<string, unknown>

const FRONT = '@builtin_plane_front'

/** The 40 x 30 base on Front, extruded `distance` along its normal. */
function plate(distance: number): Dict[] {
  return [rectSketchSk('sk1', 40, 30, FRONT), extrudeSpec('sk1', 'ex1', { distance })]
}

/** The 5 x 5 cut profile on `plane`, as the second sketch. */
function slotSketch(plane = FRONT): Dict {
  return rectSketchSk('sk2', 5, 5, plane)
}

/** A 5 x 5 cut along the plane normal. */
function cut(termination: string, extra: Dict = {}): Dict {
  return {
    id: 'ex2', kind: 'extrude', label: 'Cut',
    extrude: {
      sketch: '@sk2', distance: 1, direction: 'normal', operation: 'cut', termination, ...extra,
    },
  }
}

/** A construction plane offset from Front by `offset`. */
function offsetPlane(id: string, offset: number): Dict {
  return { id, kind: 'plane', definition: { mode: 'offset', plane: FRONT, offset } }
}

/** The live body's own volume at the checkpoint a feature left behind. */
function bodyVolume(h: SharedHarness, result: BuildResponse, featureId: string, bodyId: string): number {
  const snapshot = result._build_state!.checkpoints[featureId].body_store_snapshot
  const handle = snapshot[bodyId]?.shape
  if (handle === undefined || handle === null) throw new Error(`body '${bodyId}' is not live at ${featureId}`)
  const scope = new DisposeScope()
  try {
    return volumeOf(oc!, scope, h.table.get<OccShape>(handle))
  } finally {
    scope.dispose()
  }
}

describe.skipIf(!oc || !solveBytes)('extrude through_all (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  it('cuts the whole 10 mm thickness even with a stored distance of 1', () => {
    const result = h.run({ features: [...plate(10), slotSketch(), cut('through_all')] })
    expect(h.res(result, 'ex2').status).toBe('ok')
    // 12000 - 25 * 10. The blind control below leaves the 1 mm pocket.
    expect(bodyVolume(h, result, 'ex2', 'body_ex1')).toBeCloseTo(11750, 6)
  }, 240_000)

  it('leaves the pinned 1 mm pocket when the same cut is blind', () => {
    // The pre-fix behaviour the new termination replaces: a guessed distance is
    // part of the document and the cut stops at it, so a distance of 1 removes
    // only 25 * 1 and leaves 9 mm of the slot as a pocket.
    const result = h.run({ features: [...plate(10), slotSketch(), cut('blind')] })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(bodyVolume(h, result, 'ex2', 'body_ex1')).toBeCloseTo(12000 - 25, 6)
  }, 240_000)

  it('re-sizes when the base grows, where a blind guess would leave a plug', () => {
    const grown = h.run({ features: [...plate(20), slotSketch(), cut('through_all')] })
    expect(h.res(grown, 'ex2').status).toBe('ok')
    // 24000 - 25 * 20: the cut follows the grown thickness.
    expect(bodyVolume(h, grown, 'ex2', 'body_ex1')).toBeCloseTo(23500, 6)

    // The old guessed distance cuts only the first 10 mm and leaves a plug.
    const blind = h.run({ features: [...plate(20), slotSketch(), cut('blind', { distance: 10 })] })
    expect(h.res(blind, 'ex2').status).toBe('ok')
    expect(bodyVolume(h, blind, 'ex2', 'body_ex1')).toBeCloseTo(23750, 6)
  }, 240_000)

  it('narrows to merge_target and leaves a far body whole', () => {
    // Two 10 x 10 x 5 plates 50 mm apart on the cut axis. Sizing from both would
    // produce a 55 mm tool, which is harmless; the body operation must still
    // cut only the named plate.
    const result = h.run({
      features: [
        rectSketchSk('skA', 10, 10, FRONT),
        extrudeSpec('skA', 'exA', { distance: 5 }),
        offsetPlane('plB', 50),
        rectSketchSk('skB', 10, 10, '@plB'),
        extrudeSpec('skB', 'exB', { distance: 5 }),
        rectSketchSk('skC', 2, 2, FRONT),
        {
          id: 'exC', kind: 'extrude', label: 'Cut',
          extrude: {
            sketch: '@skC', distance: 1, direction: 'normal', operation: 'cut',
            termination: 'through_all', merge_target: 'body_exA',
          },
        },
      ],
    })
    expect(h.res(result, 'exC').status).toBe('ok')
    expect(bodyVolume(h, result, 'exC', 'body_exA')).toBeCloseTo(500 - 4 * 5, 6)
    expect(bodyVolume(h, result, 'exC', 'body_exB')).toBeCloseTo(500, 6)
  }, 240_000)

  it('sizes from the whole store when merge_target names no live body, then refuses it', () => {
    // The sizing fallback must not turn a bad target into a sizing error: the
    // body operation owns that diagnosis and names the id it could not find.
    const result = h.run({
      features: [
        rectSketchSk('skA', 10, 10, FRONT),
        extrudeSpec('skA', 'exA', { distance: 5 }),
        rectSketchSk('skC', 2, 2, FRONT),
        {
          id: 'exC', kind: 'extrude', label: 'Cut',
          extrude: {
            sketch: '@skC', distance: 1, direction: 'normal', operation: 'cut',
            termination: 'through_all', merge_target: 'body_missing',
          },
        },
      ],
    })
    const res = h.res(result, 'exC')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toContain("merge target 'body_missing' not found")
    expect(bodyVolume(h, result, 'exC', 'body_exA')).toBeCloseTo(500, 6)
  }, 240_000)

  it('reports a named exception when there is no body to size the cut from', () => {
    // A later feature in the same log still solves: one throwing leaf must not
    // take the rest of the build down.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 5, 5, FRONT),
        cut('through_all', { sketch: '@sk1' }),
        rectSketchSk('sk3', 4, 4, FRONT),
        extrudeSpec('sk3', 'ex3', { distance: 2 }),
      ],
    })
    const res = h.res(result, 'ex2')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toContain('through_all')
    expect(String(res.exception)).toContain('merge_target')
    expect(h.res(result, 'ex3').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex3')
  }, 240_000)

  it('refuses through_all for add, new and intersect by name', () => {
    for (const operation of ['add', 'new', 'intersect']) {
      const result = h.run({
        features: [
          rectSketchSk('sk1', 5, 5, FRONT),
          {
            id: 'ex1', kind: 'extrude', label: 'Extrude',
            extrude: { sketch: '@sk1', distance: 5, operation, termination: 'through_all' },
          },
        ],
      })
      const res = h.res(result, 'ex1')
      expect(res.status, operation).toBe('exception')
      expect(String(res.exception), operation).toContain('through_all')
      expect(String(res.exception), operation).toContain(operation)
    }
  }, 240_000)

  it('cuts both sides of the profile plane with direction symmetric', () => {
    // The offset plane sits at z=5 inside the 0..10 body. Symmetric shifts it
    // back by half the 10 mm measured length, so the tool straddles the plane
    // and clears the whole thickness.
    const result = h.run({
      features: [
        ...plate(10),
        offsetPlane('plMid', 5),
        slotSketch('@plMid'),
        cut('through_all', { direction: 'symmetric' }),
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(bodyVolume(h, result, 'ex2', 'body_ex1')).toBeCloseTo(11750, 6)
  }, 240_000)

  it('cuts only the reverse side from an offset plane inside the body', () => {
    // The plane sits at z=4 inside the 0..10 body. Reverse sweeps the measured
    // 10 mm from the plane toward -z, so only the 4 mm behind the plane goes;
    // sweeping the normal side instead would remove 6 mm.
    const result = h.run({
      features: [
        ...plate(10),
        offsetPlane('plMid', 4),
        slotSketch('@plMid'),
        cut('through_all', { direction: 'reverse' }),
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(bodyVolume(h, result, 'ex2', 'body_ex1')).toBeCloseTo(12000 - 25 * 4, 6)
  }, 240_000)

  it('registers no top_face, so a later plane naming one is refused', () => {
    const result = h.run({
      features: [
        ...plate(10),
        slotSketch(),
        cut('through_all'),
        { id: 'plBad', kind: 'plane', definition: { mode: 'offset', plane: '@ex2/top_face', offset: 1 } },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    const res = h.res(result, 'plBad')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toContain('@ex2/top_face')
    expect(String(res.exception)).toContain('use one of')
  }, 240_000)
})
