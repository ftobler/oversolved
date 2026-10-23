// @vitest-environment node
//
// The run reply's per-feature delta rows. The geometry read itself is covered
// through the real kernel in the CLI/MCP smoke suite; this pins the reply rule:
// a clean feature gets the checkpoint's cumulative volume/bbox and the change
// from the previous checkpoint, while a failed or warning feature gets no row
// and cannot make a later delta look like it started from nothing.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureDeltaRows } from '../featureDeltas'
import type { FeatureMeasure } from '@/kernel/solveLocally'
import type { FeatureOutcome } from '../featureOutcome'

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

  it('omits a failed or warning feature but keeps its checkpoint as the baseline', () => {
    const outcomes: Record<string, FeatureOutcome> = {
      ...CLEAN,
      ex1: { status: 'exception', exception: 'profile missing' },
      fi1: { status: 'ok', warning: 'one edge was skipped' },
    }
    const rows = featureDeltaRows(DOC, MEASURES, outcomes)
    // sk1 is still clean; both failed statements are absent; ex2 measures from
    // the geometry that actually existed after them, not from ex1's volume.
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex2'])
    expect(rows[1].volumeDelta).toBe(14000 - 11922.743)
  })

  it('leaves features the solve never reached out of the rows', () => {
    const rows = featureDeltaRows(DOC, MEASURES.slice(0, 2), CLEAN)
    expect(rows.map(row => row.id)).toEqual(['sk1', 'ex1'])
  })
})
