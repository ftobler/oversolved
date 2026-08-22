// Always-on tests for the revolve leaf's OCC-free guard paths (phase 2f). The
// geometry-producing paths are gated in occ/revolveReal.test.ts; here we only
// exercise the validation/error branches of solveRevolve that run before any OCC
// call, so `oc`/`table` are never touched.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveRevolve, resolveRevolveAxis } from './revolve'
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

  it('reads sketch/angle from the nested revolve sub-dict and fails on the no-profile branch', () => {
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
    // A part-less revolve is surfaced as a failure, not a silent ok.
    expect(result.status).toBe('error')
    expect(result.exception).toMatch(/no closed profile/)
    expect(result.mesh_warning).toMatch(/no closed profile/)
  })

  it('rejects a NaN angle the same way as a zero-string angle', () => {
    // 'not-a-number' is truthy, so it survives the `||` default-chain and
    // Number() coerces it to NaN, which `=== 0` alone would miss.
    const repo = new Repository()
    expect(() =>
      solveRevolve(oc, scope, table, { id: 'f1', revolve: { sketch: '$sk', angle: 'not-a-number' } }, repo, {}),
    ).toThrow(/angle must be non-zero/)
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

// Fail-loud guards for the revolve axis resolver. The bug report
// `revolve_bug_20260707_151218.md` surfaces a stale `axis` query (the body
// rebuilt under new ancestry tokens at the same physical edge); the registry
// returns null, the resolver silently kept the default [0,0,0]/[0,0,1] axis, and
// the revolve produced a wrong (squished) solid at the world-origin axis. A
// thrown error surfaces the revolve as red so the user re-picks the axis
// instead of getting a fail-wrong result. Mirrors transformMirror's
// `rotation_axis not found` guard.
describe('resolveRevolveAxis fail-loud guards', () => {
  it('keeps the stored default when no axis query is set', () => {
    const repo = new Repository()
    const [origin, direction] = resolveRevolveAxis({}, repo, {})
    expect(origin).toEqual([0, 0, 0])
    expect(direction).toEqual([0, 0, 1])
  })

  it('throws when the axis query does not resolve (stale pick)', () => {
    const repo = new Repository()
    expect(() =>
      resolveRevolveAxis({ axis: '@missing' }, repo, {}),
    ).toThrow(/axis query did not resolve/)
  })

  it('throws when the resolved payload has an unrecognised shape', () => {
    const repo = new Repository()
    repo.register('weird', { type: 'flatface', body_id: 'b1' })
    expect(() =>
      resolveRevolveAxis({ axis: '@weird' }, repo, {}),
    ).toThrow(/carries no usable axis/)
  })

  it('throws on a degenerate line edge (start == end)', () => {
    const repo = new Repository()
    repo.register('degenerate', {
      type: 'straightedge',
      start: [1, 2, 3],
      end: [1, 2, 3],
    })
    expect(() =>
      resolveRevolveAxis({ axis: '@degenerate' }, repo, {}),
    ).toThrow(/carries no usable axis/)
  })

  it('throws on a zero-length circle axis (no plane normal)', () => {
    const repo = new Repository()
    repo.register('flatcircle', {
      type: 'edge',
      center: [0, 0, 0],
      axis: [0, 0, 0],
    })
    expect(() =>
      resolveRevolveAxis({ axis: '@flatcircle' }, repo, {}),
    ).toThrow(/carries no usable axis/)
  })

  it('throws when a sketch-line axis has no registered sketch plane', () => {
    // The branch mirrors the bug-report-style silent fallback for sketch-line
    // axis picks when the owning sketch (and its _pt_<id> plane) was removed.
    const repo = new Repository()
    repo.register('sk_line', {
      type: 'straightedge',
      kind: 'line',
      external_params: [0, 0, 1, 1],
      sketch_id: 'deleted_sketch',
    })
    expect(() =>
      resolveRevolveAxis({ axis: '@sk_line' }, repo, {}),
    ).toThrow(/carries no usable axis/)
  })

  it('applies the line edge direction when the payload carries start/end', () => {
    const repo = new Repository()
    repo.register('edge', {
      type: 'straightedge',
      start: [1, 2, 3],
      end: [1, 2, 8],
    })
    const [origin, direction] = resolveRevolveAxis({ axis: '@edge' }, repo, {})
    expect(origin).toEqual([1, 2, 3])
    expect(direction).toEqual([0, 0, 1])
  })
})
