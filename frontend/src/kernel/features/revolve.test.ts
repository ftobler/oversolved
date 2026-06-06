// Always-on tests for the revolve leaf's OCC-free guard paths (phase 2f). The
// geometry-producing paths are gated in occ/revolveReal.test.ts; here we only
// exercise the validation/error branches of solveRevolve that run before any OCC
// call, so `oc`/`table` are never touched.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveRevolve } from './revolve'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

describe('solveRevolve guard paths', () => {
  it('requires at least one profile reference', () => {
    const repo = new Repository()
    expect(() =>
      solveRevolve(oc, scope, table, { id: 'f1', revolve: {} }, repo, {}),
    ).toThrow(/at least one profile reference/)
  })

  it('surfaces an unresolved sketch ref as the collected profile error', () => {
    const repo = new Repository()
    const bodyStore: Record<string, Body> = {}
    expect(() =>
      solveRevolve(
        oc,
        scope,
        table,
        { id: 'f1', revolve: { sketch: '$missing', angle: 90 } },
        repo,
        bodyStore,
      ),
    ).toThrow(/sketch not found: missing/)
  })

  it('reads sketch/angle from the nested revolve sub-dict and reaches the no-profile warning', () => {
    const repo = new Repository()
    repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
    repo.register('_topo_sk', { surfaces: [] })
    const result = solveRevolve(
      oc,
      scope,
      table,
      { id: 'f1', revolve: { sketch: '$sk', angle: 90 } },
      repo,
      {},
    )
    expect(result.status).toBe('ok')
    expect(result.mesh_warning).toMatch(/no closed profile/)
  })

  it('angle=0 defaults to 360 (no error)', () => {
    /** angle=0 is coerced to 360 by the || operator -- no error.
     *  This is intentional upstream behavior, not a bug. */
    const repo = new Repository()
    repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
    expect(() =>
      solveRevolve(oc, scope, table, { id: 'f1', revolve: { sketch: '$sk', angle: 0 } }, repo, {}),
    ).not.toThrow(/angle must be non-zero/)
  })
})
