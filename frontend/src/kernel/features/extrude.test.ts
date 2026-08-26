// Always-on tests for the extrude leaf's OCC-free guard paths (phase 2f). The
// geometry-producing paths are gated in occ/prismLineageReal.test.ts; here we
// only exercise the validation/error branches of solveExtrude that run before
// any OCC call, so `oc`/`table` are never touched.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveExtrude } from './extrude'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

describe('solveExtrude guard paths', () => {
  it('requires at least one profile reference', () => {
    const repo = new Repository()
    expect(() =>
      solveExtrude(oc, scope, table, { id: 'f1', extrude: {} }, repo, {}),
    ).toThrow(/at least one profile reference/)
  })

  it('rejects a NaN distance the same way as a zero distance', () => {
    // 'not-a-number' is truthy, so it survives the default-chain and
    // Number() coerces it to NaN, which `=== 0` alone would miss.
    const repo = new Repository()
    expect(() =>
      solveExtrude(oc, scope, table, { id: 'f1', extrude: { distance: 'not-a-number' } }, repo, {}),
    ).toThrow(/distance must be non-zero/)
  })

  it('rejects an explicit zero distance instead of coercing the default', () => {
    // 0 is falsy, so the old `||` chain swallowed it into the 1.0 default and
    // the extrude silently succeeded at the wrong depth. Nullish coalescing
    // keeps the explicit zero, which lands on the non-zero validation throw.
    const repo = new Repository()
    expect(() =>
      solveExtrude(oc, scope, table, { id: 'f1', extrude: { distance: 0 } }, repo, {}),
    ).toThrow(/distance must be non-zero/)
  })

  it('rejects an explicit zero depth alias the same way', () => {
    const repo = new Repository()
    expect(() =>
      solveExtrude(oc, scope, table, { id: 'f1', extrude: { depth: 0 } }, repo, {}),
    ).toThrow(/distance must be non-zero/)
  })

  it('surfaces an unresolved sketch ref as the collected profile error', () => {
    const repo = new Repository()
    const bodyStore: Record<string, Body> = {}
    expect(() =>
      solveExtrude(
        oc,
        scope,
        table,
        { id: 'f1', extrude: { sketch: '$missing', distance: 5 } },
        repo,
        bodyStore,
      ),
    ).toThrow(/sketch not found: missing/)
  })

  it('reads sketch/distance from the nested extrude sub-dict', () => {
    // An empty topology resolves to no loops; collectExtrudeLoops still succeeds
    // (registers the top face), so we reach the "no closed profile" branch --
    // proving the sub-dict merge + $sketch path ran. A part-less extrude is now
    // surfaced as a failure (status error), not a silent ok.
    const repo = new Repository()
    repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
    repo.register('_topo_sk', { surfaces: [] })
    const result = solveExtrude(
      oc,
      scope,
      table,
      { id: 'f1', extrude: { sketch: '$sk', distance: 3 } },
      repo,
      {},
    )
    expect(result.status).toBe('error')
    expect(result.exception).toMatch(/no closed profile/)
    expect(result.mesh_warning).toMatch(/no closed profile/)
  })
})
