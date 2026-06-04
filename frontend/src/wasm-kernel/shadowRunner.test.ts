/**
 * End-to-end test of the live shadow path: hand-written `$`-form PartDoc
 * sketches (as the live app stores them) lowered + solved by the real Rust wasm
 * and diffed against the canonical Python results from the regression baseline.
 * This exercises partDocToSketches -> compareSketch on the live constraint
 * representation (query strings), which the corpus baseline does not.
 */

import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import baseline from './regression-baseline.json'
import { loadSolver } from './loadSolver'
import { runShadow } from './shadowRunner'

const solve = loadSolver()

interface Entry {
  label: string
  result: Record<string, { status: string; geometry?: Record<string, number[]>; features?: Record<string, { status: string }> }>
}
const entries = baseline as unknown as Entry[]
const resultFor = (label: string, fid: string) =>
  entries.find((e) => e.label === label)!.result[fid]

// rect_sketch_10x10, in the live `$`-ref form the frontend stores.
const rectFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
  plane: '@builtin_plane_front',
  entities: [
    { id: 'bottom', kind: 'line' },
    { id: 'right', kind: 'line' },
    { id: 'top', kind: 'line' },
    { id: 'left', kind: 'line' },
  ],
  initial: {
    bottom: [0, 0, 10, 0],
    right: [10, 0, 10, 10],
    top: [10, 10, 0, 10],
    left: [0, 10, 0, 0],
  },
  constraints: [
    { id: 'c1', kind: 'coincident', a: '$bottomend', b: '$rightstart' },
    { id: 'c2', kind: 'coincident', a: '$rightend', b: '$topstart' },
    { id: 'c3', kind: 'coincident', a: '$topend', b: '$leftstart' },
    { id: 'c4', kind: 'coincident', a: '$leftend', b: '$bottomstart' },
    { id: 'c5', kind: 'horizontal', target: '$bottom' },
    { id: 'c6', kind: 'horizontal', target: '$top' },
    { id: 'c7', kind: 'vertical', target: '$right' },
    { id: 'c8', kind: 'vertical', target: '$left' },
    { id: 'c9', kind: 'length', target: '$bottom', value: 10 },
    { id: 'c10', kind: 'length', target: '$left', value: 10 },
  ],
}

// sketch_distance_10
const distFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
  plane: '@builtin_plane_front',
  entities: [
    { id: 'p1', kind: 'point' },
    { id: 'p2', kind: 'point' },
  ],
  initial: { p1: [0, 0], p2: [8, 6] },
  constraints: [
    { id: 'c_fix1', kind: 'fixed', target: '$p1', x: 0, y: 0 },
    { id: 'c_dist', kind: 'point_distance', a: '$p1', b: '$p2', value: 10 },
  ],
}

describe.skipIf(!solve)('live shadow runner (Rust vs Python, $-form constraints)', () => {
  it('matches Python on a rectangle sketch', () => {
    const report = runShadow([rectFeature], { sk1: resultFor('rect_sketch_10x10', 'sk1') }, solve!)
    expect(report.comparedCount).toBe(1)
    expect(report.mismatchCount, JSON.stringify(report.entries, null, 2)).toBe(0)
  })

  it('matches Python on a point-distance sketch', () => {
    const report = runShadow([distFeature], { sk1: resultFor('sketch_distance_10', 'sk1') }, solve!)
    expect(report.comparedCount).toBe(1)
    expect(report.mismatchCount, JSON.stringify(report.entries, null, 2)).toBe(0)
  })

  it('records skips for projection sketches without comparing', () => {
    const proj: PartFeature = {
      id: 'skp',
      kind: 'sketch',
      entities: [{ id: 'l1', kind: 'line', source: '@sketch0/line1' }],
      initial: {},
      constraints: [],
    }
    const report = runShadow([proj], {}, solve!)
    expect(report.comparedCount).toBe(0)
    expect(report.entries[0].skipped).toMatch(/projection/)
  })
})
