// Always-on tests for the extrude leaf's OCC-free guard paths (phase 2f). The
// geometry-producing paths are gated in occ/prismLineageReal.test.ts; here we
// only exercise the validation/error branches of solveExtrude that run before
// any OCC call, so `oc`/`table` are never touched.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Repository } from '../query'
import { solveExtrude } from './extrude'
import { collectExtrudeLoops } from './faceProfile'
import { faceNormal, faceCentroid } from '../occ/primitives'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { Body } from '../types3d'

// The mixed-profile and non-coplanar refusals need a profile that resolves to a
// body face, which the OCC-free harness cannot produce (a face only ever comes
// out of an OCC face read). Drive collectExtrudeLoops with a call-through double
// so the pre-existing tests keep the real $sketch path, and override it per-test
// to hand solveExtrude a face+loops or a multi-face profile.
vi.mock('./faceProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./faceProfile')>()
  return { ...actual, collectExtrudeLoops: vi.fn(actual.collectExtrudeLoops) }
})
// The coplanar guard reads face normals and centroids; the OCC-free harness has
// no oc, so the read is stubbed for the one test that reaches it.
vi.mock('../occ/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../occ/primitives')>()
  return { ...actual, faceNormal: vi.fn(), faceCentroid: vi.fn() }
})

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

const plane = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

afterEach(() => {
  vi.mocked(collectExtrudeLoops).mockRestore()
  vi.mocked(faceNormal).mockReset()
  vi.mocked(faceCentroid).mockReset()
})

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

  it('refuses a profile mixing a picked body face with sketch loops', () => {
    // Both a face ref and a loop ref resolved; only one branch below can consume
    // them, so the mixed pick must be refused by name instead of silently
    // dropping the faces (which would leave profile_queries naming geometry the
    // body does not contain).
    const repo = new Repository()
    vi.mocked(collectExtrudeLoops).mockImplementation((_oc, _scope, _table, sketchRef) => {
      if (sketchRef === '@b1/face/0') {
        return { loops: [], plane, sketchId: 'skA', face: {} as OccShape }
      }
      return { loops: [[{ entity_id: 'e1' }]], plane, sketchId: 'skB', face: null }
    })
    expect(() =>
      solveExtrude(
        oc,
        scope,
        table,
        { id: 'f1', extrude: { sketch: ['@b1/face/0', '$sk'], distance: 3 } },
        repo,
        {},
      ),
    ).toThrow(/mixing picked faces\/edges with sketch areas/)
  })

  it('refuses a multi-face pick whose faces are not coplanar', () => {
    // Two picked faces on different planes: the prisms below are all swept along
    // face 0's normal, so the second face would grow out of its own plane.
    const repo = new Repository()
    vi.mocked(collectExtrudeLoops).mockImplementation((_oc, _scope, _table, sketchRef) => {
      return { loops: [], plane, sketchId: 'sk' + sketchRef, face: { face: sketchRef } as unknown as OccShape }
    })
    vi.mocked(faceNormal).mockReturnValueOnce([0, 0, 1]).mockReturnValue([1, 0, 0])
    vi.mocked(faceCentroid).mockReturnValueOnce([0, 0, 0]).mockReturnValue([5, 0, 0])
    expect(() =>
      solveExtrude(
        oc,
        scope,
        table,
        { id: 'f1', extrude: { sketch: ['@b1/face/0', '@b2/face/0'], distance: 3 } },
        repo,
        {},
      ),
    ).toThrow(/not coplanar/)
  })

  it('refuses a profile spanning two different sketch planes', () => {
    // Two sketches on different planes: every loop is lifted through the FIRST
    // sketch's frame, so the second profile would silently build in the wrong
    // place and orientation. The refusal compares planes, not sketch ids -- two
    // sketches on one datum plane stay a legitimate multi-sketch profile.
    const repo = new Repository()
    const top = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }
    vi.mocked(collectExtrudeLoops).mockImplementation((_oc, _scope, _table, sketchRef) => {
      if (sketchRef === '$skB') {
        return { loops: [[{ entity_id: 'e1' }]], plane: top, sketchId: 'skB', face: null }
      }
      return { loops: [[{ entity_id: 'e0' }]], plane, sketchId: 'skA', face: null }
    })
    expect(() =>
      solveExtrude(
        oc,
        scope,
        table,
        { id: 'f1', extrude: { sketch: ['$skA', '$skB'], distance: 3 } },
        repo,
        {},
      ),
    ).toThrow(/spans two different sketch planes/)
  })
})
