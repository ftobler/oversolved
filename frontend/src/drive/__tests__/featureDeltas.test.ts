// @vitest-environment node
//
// The run reply's per-feature delta rows. The geometry read itself is covered
// through the real kernel in the CLI/MCP smoke suite; this pins the reply rule:
// a built feature gets the checkpoint's cumulative volume/bbox and the change
// from the previous checkpoint, a warned one keeps its row with the warning,
// and a failed or partial one gets no row and cannot make a later delta look
// like it started from nothing.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureDeltaRows, touchedFeatureIds } from '../featureDeltas'
import type { FeatureMeasure, FeatureMeasureBody } from '@/kernel/solveLocally'
import type { FeatureOutcome } from '../featureOutcome'

// Most cases care only about a body's volume, so the topology counts default to
// a value every body shares. A case about topology moving states them itself.
const body = (volume: number, faces = 6, edges = 12): FeatureMeasureBody => ({ volume, faces, edges })

const DOC = {
  version: 1,
  kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
    { id: 'fi1', kind: 'fillet' },
    { id: 'ex2', kind: 'extrude' },
  ],
} as unknown as PartDoc

const MEASURES: FeatureMeasure[] = [
  { id: 'sk1', volume: 0, bbox: null },
  { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
  { id: 'fi1', volume: 11922.743, bbox: [0, 0, 0, 40, 10, 30] },
  { id: 'ex2', volume: 14000, bbox: [0, 0, 0, 50, 10, 30] },
]

const CLEAN: Record<string, FeatureOutcome> = {
  sk1: { status: 'fully_constrained' },
  ex1: { status: 'ok' },
  fi1: { status: 'ok' },
  ex2: { status: 'ok' },
}

describe('featureDeltaRows', () => {
  it('reports each clean feature\'s cumulative measure and its delta', () => {
    const rows = featureDeltaRows(DOC, MEASURES, CLEAN)
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex1', 'fi1', 'ex2'])
    expect(rows[0]).toMatchObject({ volume: 0, volumeDelta: 0, bbox: null, bboxDelta: null })
    expect(rows[1]).toMatchObject({
      volume: 12000,
      volumeDelta: 12000,
      bbox: [0, 0, 0, 40, 10, 30],
      bboxDelta: [0, 0, 0, 40, 10, 30],
    })
    expect(rows[2].volumeDelta).toBeCloseTo(-77.257, 3)
    expect(rows[2].bboxDelta).toEqual([0, 0, 0, 0, 0, 0])
    expect(rows[3].volumeDelta).toBeCloseTo(2077.257, 3)
    expect(rows[3].bboxDelta).toEqual([0, 0, 0, 10, 0, 0])
  })

  it('keeps a warned feature\'s row and drops only the ones the kernel did not build', () => {
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      ex1: { status: 'exception', exception: 'profile missing' },
      fi1: { status: 'ok', warning: 'one edge was skipped' },
    }
    const rows = featureDeltaRows(DOC, MEASURES, outcomes)
    // The exception has no row; the warning did build its geometry, so its row
    // is there with the kernel's text and the next delta still measures from
    // the geometry that actually existed after both.
    expect(rows.map(row => row.id)).toEqual(['sk1', 'fi1', 'ex2'])
    expect(rows[1]).toMatchObject({ id: 'fi1', status: 'ok', warning: 'one edge was skipped' })
    expect(rows[2].volumeDelta).toBe(14000 - 11922.743)
  })

  it('keeps a noted feature\'s row: a note is not a warning', () => {
    // A tangent-chain note describes geometry the feature built, so it must not
    // drop the row or report a warning the row cannot carry.
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      fi1: { status: 'ok', note: 'fillet: the picked edges continue along the tangent chain' },
    }
    const rows = featureDeltaRows(DOC, MEASURES, outcomes)
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex1', 'fi1', 'ex2'])
    expect(rows[2]).toMatchObject({ id: 'fi1', status: 'ok' })
    expect(rows[2]).not.toHaveProperty('warning')
  })

  it('gives partial and overconstrained outcomes no row but keeps a suppressed one', () => {
    for (const status of ['exception', 'partial', 'overconstrained'] as const) {
      const outcomes: Record<string, FeatureOutcome> = { ...CLEAN, ex1: { status } }
      expect(featureDeltaRows(DOC, MEASURES, outcomes).map(row => row.id), status)
        .toEqual(['sk1', 'fi1', 'ex2'])
    }
    const suppressed: Record<string, FeatureOutcome> = { ...CLEAN, ex1: { status: 'suppressed' } }
    expect(featureDeltaRows(DOC, MEASURES, suppressed).map(row => row.id)).toEqual(['sk1', 'ex1', 'fi1', 'ex2'])
  })

  it('changed mode keeps a warned feature that moved or was touched', () => {
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      fi1: { status: 'ok', warning: 'one edge was skipped' },
    }
    // fi1's own checkpoint moved; the warning must not hide a row the plain
    // coverage rule admits.
    const moved: FeatureMeasure[] = MEASURES.map(measure =>
      measure.id === 'fi1' ? { ...measure, volume: 11900 } : measure)
    const rows = featureDeltaRows(DOC, moved, outcomes, { baseline: MEASURES, mode: 'changed' })
    expect(rows.map(row => row.id)).toEqual(['fi1'])
    expect(rows[0]).toMatchObject({ id: 'fi1', warning: 'one edge was skipped' })
  })

  it('changed mode lists a touched warned sketch so its shrink reads in one call', () => {
    const warning = 'Underconstrained: 2 degrees of freedom. Free: l1, l2.'
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      sk1: { status: 'underconstrained', dof: 2, warning },
    }
    // The sketch's own checkpoint did not move, but the step touched it (it
    // added a constraint); the row carries the remaining DOF.
    const rows = featureDeltaRows(DOC, MEASURES, outcomes, {
      baseline: MEASURES,
      touched: new Set(['sk1']),
      mode: 'changed',
    })
    expect(rows).toEqual([expect.objectContaining({ id: 'sk1', status: 'underconstrained', dof: 2, warning })])
  })

  it('carries a hole\'s resolved drill side on its row, and no side elsewhere', () => {
    // A through hole under `normal` may have drilled `reverse`; the row says so
    // without anyone measuring cylinder faces to find which way it went.
    const rows = featureDeltaRows(DOC, MEASURES, { ...CLEAN, fi1: { status: 'ok', direction: 'reverse' } })
    expect(rows.find(row => row.id === 'fi1')?.direction).toBe('reverse')
    expect(rows.find(row => row.id === 'ex1')).not.toHaveProperty('direction')
  })

  it('leaves features the solve never reached out of the rows', () => {
    const rows = featureDeltaRows(DOC, MEASURES.slice(0, 2), CLEAN)
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex1'])
  })

  it('changed mode drops rows whose checkpoint matches the input solve', () => {
    const rows = featureDeltaRows(DOC, MEASURES, CLEAN, { baseline: MEASURES, mode: 'changed' })
    expect(rows).toEqual([])
  })

  it('changed mode keeps an added feature and a touched solid one', () => {
    const withAdded = {
      ...DOC,
      features: [...(DOC.features ?? []), { id: 'ex3', kind: 'extrude' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [...MEASURES, { id: 'ex3', volume: 15000, bbox: [0, 0, 0, 60, 10, 30] }]
    const outcomes: Record<string, FeatureOutcome> = { ...CLEAN, ex3: { status: 'ok' } }
    // fi1 was named by the steps and is solid-producing, so it keeps its row
    // even though the measure matches; ex3 is new and has no baseline row.
    const rows = featureDeltaRows(withAdded, measures, outcomes, {
      baseline: MEASURES,
      touched: new Set(['fi1']),
      mode: 'changed',
    })
    expect(rows.map(row => row.id)).toEqual(['fi1', 'ex3'])
  })

  // The sketch-protection probe: one add_projected_entity into an existing,
  // fully constrained sketch. Nothing the checkpoint measures moved, yet the
  // author needs the row to see the projection kept the sketch at dof 0.
  it('changed mode lists a touched clean sketch so its dof reads in one call', () => {
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      sk1: { status: 'fully_constrained', dof: 0 },
    }
    const rows = featureDeltaRows(DOC, MEASURES, outcomes, {
      baseline: MEASURES,
      touched: new Set(['sk1']),
      mode: 'changed',
    })
    expect(rows).toEqual([expect.objectContaining({
      id: 'sk1',
      status: 'fully_constrained',
      dof: 0,
      volumeDelta: 0,
      bboxDelta: null,
    })])
  })

  it('changed mode lists a touched plane whose own delta is zero', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'sk1', kind: 'sketch' }, { id: 'pl1', kind: 'plane' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null },
      { id: 'pl1', volume: 0, bbox: null },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      sk1: { status: 'ok' },
      pl1: { status: 'ok' },
    }
    // A set_plane_definition_field step names the plane; the zero rule must not
    // hide it.
    const rows = featureDeltaRows(doc, measures, outcomes, {
      baseline: measures,
      touched: new Set(['pl1']),
      mode: 'changed',
    })
    expect(rows).toEqual([expect.objectContaining({
      id: 'pl1',
      status: 'ok',
      volumeDelta: 0,
      bboxDelta: null,
    })])
  })

  // The admission is additive: a warned feature the steps touched kept its row
  // before the reference rule, and a non-reference kind must not lose it now.
  it('changed mode keeps a touched warned non-reference row', () => {
    const doc = {
      ...DOC,
      features: [{ id: 'hx1', kind: 'helix' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [{ id: 'hx1', volume: 0, bbox: null }]
    const warning = 'the helix ran past the height its sweep uses'
    const outcomes: Record<string, FeatureOutcome> = {
      hx1: { status: 'ok', warning },
    }
    const rows = featureDeltaRows(doc, measures, outcomes, {
      baseline: measures,
      touched: new Set(['hx1']),
      mode: 'changed',
    })
    expect(rows).toEqual([expect.objectContaining({ id: 'hx1', warning })])
  })

  // Bearing notes: a variable edit moves every downstream checkpoint, so each
  // sketch after the first extrude showed up as a zero-contribution row. The
  // edit touches the variable, not the sketches; the sketches stay out.
  it('changed mode leaves every downstream sketch out of a variable edit', () => {
    const doc = {
      ...DOC,
      features: [
        { id: 'var1', kind: 'variable' },
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'sk2', kind: 'sketch' },
        { id: 'sk3', kind: 'sketch' },
        { id: 'sk4', kind: 'sketch' },
      ],
    } as unknown as PartDoc
    const before: FeatureMeasure[] = [
      { id: 'var1', volume: 0, bbox: null },
      { id: 'sk1', volume: 0, bbox: null },
      { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
      { id: 'sk2', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
      { id: 'sk3', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
      { id: 'sk4', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
    ]
    const after: FeatureMeasure[] = [
      { id: 'var1', volume: 0, bbox: null },
      { id: 'sk1', volume: 0, bbox: null },
      { id: 'ex1', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
      { id: 'sk2', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
      { id: 'sk3', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
      { id: 'sk4', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      var1: { status: 'ok' },
      sk1: { status: 'ok' },
      ex1: { status: 'ok' },
      sk2: { status: 'ok' },
      sk3: { status: 'ok' },
      sk4: { status: 'ok' },
    }
    const rows = featureDeltaRows(doc, after, outcomes, {
      baseline: before,
      touched: new Set(['var1']),
      mode: 'changed',
    })
    expect(rows.map(row => row.id)).toEqual(['ex1'])
  })

  // Bearing notes: a variable edit moved every downstream checkpoint, so each
  // sketch after the first extrude showed up as a zero-contribution row.
  it('changed mode leaves out an existing sketch whose own delta is zero', () => {
    const doc = {
      ...DOC,
      features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }, { id: 'sk2', kind: 'sketch' }],
    } as unknown as PartDoc
    const before: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null },
      { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
      { id: 'sk2', volume: 12000, bbox: [0, 0, 0, 40, 10, 30] },
    ]
    const after: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null },
      { id: 'ex1', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
      { id: 'sk2', volume: 24000, bbox: [0, 0, 0, 40, 20, 30] },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      sk1: { status: 'ok' }, ex1: { status: 'ok' }, sk2: { status: 'ok' },
    }
    const rows = featureDeltaRows(doc, after, outcomes, { baseline: before, mode: 'changed' })
    expect(rows.map(row => row.id)).toEqual(['ex1'])
  })

  // slide_latch F3 / ppp0105: the reply did not say which body took the
  // material, and `volume` (all bodies) read like one body's volume.
  it('names the body a feature changed and that body\'s own volume', () => {
    const measures: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null, bodies: {} },
      { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30], bodies: { body_ex1: body(8000), body_ex9: body(4000) } },
      { id: 'fi1', volume: 11922.743, bbox: [0, 0, 0, 40, 10, 30], bodies: { body_ex1: body(7922.743), body_ex9: body(4000) } },
      { id: 'ex2', volume: 14000, bbox: [0, 0, 0, 50, 10, 30], bodies: { body_ex1: body(7922.743), body_ex9: body(6077.257) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      sk1: { status: 'ok' },
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      fi1: { status: 'ok', bodyId: 'body_ex1' },
      ex2: { status: 'ok', bodyId: 'body_ex9' },
    }
    const rows = featureDeltaRows(DOC, measures, outcomes)
    expect(rows[0].body).toBeUndefined()
    expect(rows[1]).toMatchObject({ body: 'body_ex1', bodyVolume: 8000, volume: 12000 })
    expect(rows[3]).toMatchObject({ body: 'body_ex9', bodyVolume: 6077.257 })
  })

  it('all mode keeps every clean row even against an identical baseline', () => {
    const rows = featureDeltaRows(DOC, MEASURES, CLEAN, { baseline: MEASURES, mode: 'all' })
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex1', 'fi1', 'ex2'])
  })

  // build123d topology_selection F5: a 4 x 4 `add` array of fins whose copies
  // do not touch kept body_ex2 on the source and minted body_ex2_1.._15 for the
  // copies, yet the row named the source with all 900 mm3 of the copies' volume.
  it('reports a disjoint array as a changed-body count, not its untouched source', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex2', kind: 'extrude' },
        { id: 'ar1', kind: 'pattern' },
      ],
    } as unknown as PartDoc
    const copies: Record<string, FeatureMeasureBody> = { body_ex2: body(60) }
    for (let i = 1; i <= 15; i++) copies[`body_ex2_${i}`] = body(60)
    const measures: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null, bodies: {} },
      { id: 'ex2', volume: 60, bbox: [0, 0, 0, 2, 3, 10], bodies: { body_ex2: body(60) } },
      { id: 'ar1', volume: 960, bbox: [0, 0, 0, 40, 40, 10], bodies: copies },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      sk1: { status: 'ok' },
      ex2: { status: 'ok', bodyId: 'body_ex2' },
      ar1: { status: 'ok', bodyId: 'body_ex2' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex2', bodyVolume: 60 })
    expect(rows[2].body).toBeUndefined()
    expect(rows[2].bodyVolume).toBeUndefined()
    expect(rows[2]).toMatchObject({ changedBodyCount: 15, volume: 960, volumeDelta: 900 })
  })

  it('names the one body a cut changed, with that body\'s own volume', () => {    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'cut1', kind: 'extrude' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30], bodies: { body_ex1: body(12000) } },
      { id: 'cut1', volume: 7922.743, bbox: [0, 0, 0, 40, 10, 30], bodies: { body_ex1: body(7922.743) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      cut1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex1', bodyVolume: 7922.743 })
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  it('names a fused add, whose source body grew and kept its id', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex2', kind: 'extrude' }, { id: 'ar1', kind: 'pattern' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex2', volume: 60, bbox: [0, 0, 0, 2, 3, 10], bodies: { body_ex2: body(60) } },
      { id: 'ar1', volume: 120, bbox: [0, 0, 0, 4, 3, 10], bodies: { body_ex2: body(120) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex2: { status: 'ok', bodyId: 'body_ex2' },
      ar1: { status: 'ok', bodyId: 'body_ex2' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex2', bodyVolume: 120 })
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  // Bullet 2: the reported body is untouched, so the one body that did move is
  // the honest name (a one-copy disjoint array, say).
  it('names the one other body when the feature\'s own body did not change', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex2', kind: 'extrude' }, { id: 'ar1', kind: 'pattern' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex2', volume: 60, bbox: [0, 0, 0, 2, 3, 10], bodies: { body_ex2: body(60) } },
      {
        id: 'ar1', volume: 120, bbox: [0, 0, 0, 20, 3, 10],
        bodies: { body_ex2: body(60), body_ex2_1: body(60) },
      },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex2: { status: 'ok', bodyId: 'body_ex2' },
      ar1: { status: 'ok', bodyId: 'body_ex2' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex2_1', bodyVolume: 60 })
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  it('leaves the body fields off a touched feature that changed no body measure', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'fi1', kind: 'fillet' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000, 8, 18) } },
      { id: 'fi1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000, 8, 18) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      fi1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    // The row exists because the steps touched it, but it may not claim the
    // untouched body.
    expect(rows[1]).toMatchObject({ id: 'fi1', volumeDelta: 0 })
    expect(rows[1].body).toBeUndefined()
    expect(rows[1].bodyVolume).toBeUndefined()
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  // The practice run's bent bar: a fillet over the convex and concave bend
  // edges moves material both ways, so the net volume and the bbox are
  // unchanged while two faces and two edges appear. Naming no body there reads
  // as "the fillet changed nothing".
  it('names a body whose face and edge counts moved with no volume change', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'fi1', kind: 'fillet' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000, 8, 18) } },
      { id: 'fi1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000, 10, 20) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      fi1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ id: 'fi1', volumeDelta: 0, body: 'body_ex1', bodyVolume: 8000 })
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  it('names the preferred first body of a split and counts both changed bodies', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'ex1', kind: 'extrude' },
        { id: 'bo1', kind: 'boolean' },
        { id: 'fi1', kind: 'fillet' },
      ],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30], bodies: { body_ex1: body(12000) } },
      {
        id: 'bo1', volume: 12000, bbox: [0, 0, 0, 40, 10, 30],
        bodies: { body_ex1: body(6000), body_ex1_1: body(6000) },
      },
      {
        id: 'fi1', volume: 11800, bbox: [0, 0, 0, 40, 10, 30],
        bodies: { body_ex1: body(5900), body_ex1_1: body(5900) },
      },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      bo1: { status: 'ok', bodyId: 'body_ex1' },
      fi1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex1', bodyVolume: 6000, changedBodyCount: 2 })
    // The split total stays the baseline: a later delta is not measured from
    // one half.
    expect(rows[2].volumeDelta).toBeCloseTo(11800 - 12000, 9)
  })

  it('still names a rigid transform or mirror body whose volume did not move', () => {
    for (const kind of ['transform', 'mirror']) {
      const doc = {
        version: 1,
        kind: 'part',
        features: [{ id: 'ex1', kind: 'extrude' }, { id: 'mv1', kind }],
      } as unknown as PartDoc
      const measures: FeatureMeasure[] = [
        { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000) } },
        { id: 'mv1', volume: 8000, bbox: [0, 0, 0, 20, 40, 20], bodies: { body_ex1: body(8000) } },
      ]
      const outcomes: Record<string, FeatureOutcome> = {
        ex1: { status: 'ok', bodyId: 'body_ex1' },
        mv1: { status: 'ok', bodyId: 'body_ex1' },
      }
      const rows = featureDeltaRows(doc, measures, outcomes)
      expect(rows[1], kind).toMatchObject({ body: 'body_ex1', bodyVolume: 8000 })
      expect(rows[1], kind).not.toHaveProperty('changedBodyCount')
    }
  })

  it('names the first solid body from an empty initial map', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'sk1', volume: 0, bbox: null, bodies: {} },
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      sk1: { status: 'ok' },
      ex1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex1', bodyVolume: 8000 })
  })

  it('counts only the live body when a boolean consumes the other one', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'bo1', kind: 'boolean' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(5000), body_ex2: body(3000) } },
      { id: 'bo1', volume: 2000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(2000) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      bo1: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ body: 'body_ex1', bodyVolume: 2000 })
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  it('omits the body fields when the checkpoint has no body map', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [{ id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20] }]
    const rows = featureDeltaRows(doc, measures, { ex1: { status: 'ok', bodyId: 'body_ex1' } })
    expect(rows[0].body).toBeUndefined()
    expect(rows[0].bodyVolume).toBeUndefined()
    expect(rows[0]).not.toHaveProperty('changedBodyCount')
  })

  it('keeps the last body map when a later checkpoint carries none', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'ex1', kind: 'extrude' },
        { id: 'fi1', kind: 'fillet' },
        { id: 'ex2', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000) } },
      { id: 'fi1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20] },
      { id: 'ex2', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok' },
      fi1: { status: 'ok' },
      ex2: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    // Resetting the baseline to {} at fi1 would make ex2 look like it created
    // the body anew and name it for a no-op extrude.
    expect(rows[2].body).toBeUndefined()
  })

  it('leaves a reference feature row out of the body rule', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'sk2', kind: 'sketch' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex1', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(8000) } },
      { id: 'sk2', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], bodies: { body_ex1: body(9000) } },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex1: { status: 'ok', bodyId: 'body_ex1' },
      sk2: { status: 'ok', bodyId: 'body_ex1' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1].body).toBeUndefined()
    expect(rows[1].bodyVolume).toBeUndefined()
    expect(rows[1]).not.toHaveProperty('changedBodyCount')
  })

  // A warned array still built its copies: the warning must not change which
  // body fields the row earns.
  it('keeps the changed-body rule on a warned array row', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex2', kind: 'extrude' }, { id: 'ar1', kind: 'pattern' }],
    } as unknown as PartDoc
    const measures: FeatureMeasure[] = [
      { id: 'ex2', volume: 60, bbox: [0, 0, 0, 2, 3, 10], bodies: { body_ex2: body(60) } },
      {
        id: 'ar1', volume: 240, bbox: [0, 0, 0, 20, 3, 10],
        bodies: { body_ex2: body(60), body_ex2_1: body(60), body_ex2_2: body(60), body_ex2_3: body(60) },
      },
    ]
    const outcomes: Record<string, FeatureOutcome> = {
      ex2: { status: 'ok', bodyId: 'body_ex2' },
      ar1: { status: 'ok', bodyId: 'body_ex2', warning: 'one copy skipped' },
    }
    const rows = featureDeltaRows(doc, measures, outcomes)
    expect(rows[1]).toMatchObject({ id: 'ar1', warning: 'one copy skipped', changedBodyCount: 3 })
    expect(rows[1].body).toBeUndefined()
  })

  it('reads touched feature ids from the mutations and the step outcomes', () => {
    const touched = touchedFeatureIds(
      [
        { mutation: { type: 'set_extrude_field', featureId: 'ex1' } },
        { command: 'undo' },
        { mutation: { type: 'add_sketch', featureId: 'sk9' } },
      ],
      [
        { index: 0, ok: true, createdIds: ['ex1'] },
        { index: 2, ok: true, createdIds: ['sk9', 'line1'] },
      ],
    )
    expect([...touched].sort()).toEqual(['ex1', 'line1', 'sk9'])
  })

  it('learns an import step\'s sketch from the mutation though its reply drops the ids', () => {
    // The compact import reply has no entity ids to harvest, but the delta row
    // still needs the sketch the step named.
    const touched = touchedFeatureIds(
      [{ mutation: { type: 'import_dxf', featureId: 'sk_import', file: 'rack' } }],
      [{ index: 0, ok: true, createdIds: [], createdCount: 12 }],
    )
    expect([...touched]).toEqual(['sk_import'])
  })

  it('reads a delete step\'s sketch from its wire refs', () => {
    // A delete carries no featureId: the sketch is the second segment of each
    // 'entity:sk1:l2' / 'vertex:sk1:l2:start' / 'constraint:sk1:c1' target.
    const touched = touchedFeatureIds(
      [{
        mutation: {
          type: 'delete',
          targets: ['constraint:sk1:c1', 'entity:sk1:l2', 'vertex:sk2:l1:start'],
        },
      }],
      [{ index: 0, ok: true, createdIds: [] }],
    )
    expect([...touched].sort()).toEqual(['sk1', 'sk2'])
  })

  it('names a copy-mode pattern\'s target sketch, not its read-only source', () => {
    // The pattern copies sk1's entities into sk2; only sk2 was authored, so a
    // row for the untouched source would be the zero noise the rule drops.
    const touched = touchedFeatureIds(
      [{
        mutation: {
          type: 'pattern_entities', featureId: 'sk1', targetFeatureId: 'sk2',
          sourceIds: ['l1'], mode: 'copy', count: 2, translate: [10, 0],
        },
      }],
      [{ index: 0, ok: true, createdIds: [] }],
    )
    expect([...touched]).toEqual(['sk2'])
  })

  it('keeps the source sketch for a pattern that repeats inside it', () => {
    const touched = touchedFeatureIds(
      [{
        mutation: {
          type: 'pattern_entities', featureId: 'sk1', sourceIds: ['l1'],
          mode: 'linear', count: 2, pitch: 10,
        },
      }],
      [{ index: 0, ok: true, createdIds: [] }],
    )
    expect([...touched]).toEqual(['sk1'])
  })
})
