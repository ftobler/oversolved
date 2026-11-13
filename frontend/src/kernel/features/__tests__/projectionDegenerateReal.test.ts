// @vitest-environment node
//
// Regression for bugreports/projection-review/nonfinite-crash.yaml. An edge-on
// projected circle lowers to the degenerate ellipse `[20, 0, 3, 0, 0]`, and two
// of them in one sketch used to fail the whole sketch with
// `exception: topology codec error: NonFinite`, taking every downstream feature
// with it. The document is loaded as the bug report holds it (a stored
// degenerate entity), which is past the authoring value rules by construction.
//
// After `projection-edge-on-line` landed both sources lower to lines, so the
// same sketch is also the coincident-lines re-probe: an overlap of collinear
// lines is a supported topology case, not an exception.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolverLoader } from '../sketch'
import { loadSolver, loadSolverFresh } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** The path of the first non-finite number in a JSON-ish value, or null. */
function nonFinitePath(v: unknown, path = ''): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path || '<root>'
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = nonFinitePath(v[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Dict)) {
      const hit = nonFinitePath(x, path ? `${path}.${k}` : k)
      if (hit) return hit
    }
  }
  return null
}

/** A part holding the builtin planes and one Top sketch. */
function topSpec(sketch: Dict, before: Dict[] = []): Dict {
  return {
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane', visible: false },
      ...before,
      sketch,
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('a degenerate projected curve never fails the sketch (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    setSketchSolverLoader(loadSolverFresh)
  })

  it('builds a loaded sketch holding two b = 0 ellipses', () => {
    // The crash the bug report carried: two coincident edge-on projections
    // stored as the degenerate ellipses the old lowering produced.
    const r = h.run(topSpec({
      id: 'skX', kind: 'sketch', plane: '@builtin_plane_top',
      entities: [{ id: 'e0', kind: 'ellipse' }, { id: 'e1', kind: 'ellipse' }],
      initial: { e0: [20, 0, 3, 0, 0], e1: [20, 0, 3, 0, 0] },
      constraints: [],
    }))
    const sk = h.res(r, 'skX')
    expect(String(sk.exception ?? '')).not.toMatch(/non-finite/i)
    expect(sk.status).not.toBe('exception')
    // Nothing the topology emits may be a NaN either: a finite status over a
    // poisoned profile would only move the failure into the next feature.
    expect(nonFinitePath(sk.topology)).toBeNull()
  })

  it('builds the same sketch when both sources re-lower to coincident lines', () => {
    // The bug document's skX: a Top sketch projecting an edge-on circle, twice.
    // Both projections land on the same segment, the collinear-overlap case the
    // area builder must accept.
    const source: Dict = {
      id: 'skh', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle' }],
      initial: { c0: [0, 5, 3] },
      constraints: [],
    }
    const r = h.run(topSpec({
      id: 'skX', kind: 'sketch', plane: '@builtin_plane_top',
      entities: [{ id: 'p0', kind: 'ellipse' }, { id: 'p1', kind: 'ellipse' }],
      initial: {},
      constraints: [
        { id: 'proj_p0', kind: 'projection', target: '$p0', source: '@skh/c0' },
        { id: 'proj_p1', kind: 'projection', target: '$p1', source: '@skh/c0' },
      ],
    }, [source]))
    const sk = h.res(r, 'skX')
    expect(String(sk.exception ?? '')).not.toMatch(/non-finite/i)
    expect(sk.status).not.toBe('exception')
    expect(nonFinitePath(sk.topology)).toBeNull()
    // The edge-on source adopted the line kind, so both entities are segments
    // and the topology dedupes the overlap instead of cutting a zero-width face.
    expect(sk.resolved_kinds).toEqual({ p0: 'line', p1: 'line' })
    const geometry = sk.geometry as Record<string, number[]> | undefined
    expect(geometry?.p0).toHaveLength(4)
    expect(geometry?.p1).toHaveLength(4)
  })
})
