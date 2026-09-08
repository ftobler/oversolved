// @vitest-environment node
//
// Corpus regression for bugreports/20260908_1723_filet_non_manifold_geometry.md
// and 20260908_1725_filet_non_manifold_geometry_2.md -- two reports, one
// document (the ASTs are byte-identical) and one defect.
//
// The user filleted a rounded corner where an earlier fillet and a chamfer had
// already met, and got a body with edges lying across faces they never split, a
// face with no border, and a hole. Both reports read as a render or tessellation
// failure; neither is. BRepFilletAPI reported IsDone() and handed back a shell
// that BRepCheck_Analyzer rejects outright, and nothing between the maker and
// the screen ever asked. The mesh was a faithful picture of a corrupt solid.
//
// The user's own request was "if a fix is not possible at least a detection and
// subsequent feature failure would be appreciated" -- OCC's blend fragility is
// not ours to fix, so occ/edgeModifier.ts gates on the analyzer and refuses.
// The refusal has to stay narrow: a blend meeting at a corner is often invalid
// only for a missing pcurve, which ShapeFix projects, and those must still
// build (filletCornerNamingReal.test.ts covers one). Only an unhealable result
// fails the feature.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { DisposeScope } from '../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { OccShape } from '../occ/occTypes'
import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'
import doc from './__fixtures__/filletInvalidResultDoc.json'

const oc = await loadOcc()
const solveBytes = loadSolver()

const EXTRUDE = 'XQve4bZ3hUdqFK-heNCKkm0T'
// The document carries two features labelled "fillet 2"; the corrupting one is
// the last feature, filleting an edge where the first fillet and the chamfer meet.
const GOOD_FILLET = 'EOvC6_TiiTec0XZuKCcwJYlz'
const BAD_FILLET = 'YrOFu4qequmOjI-UO1K_PMc-'
const BODY = `body_${EXTRUDE}`

const features = doc as unknown as Array<Record<string, unknown>>

function statusOf(r: BuildResponse, fid: string): string {
  return (r.result as Record<string, { status?: string }>)[fid]?.status ?? 'missing'
}

/** The body's shape as the checkpoint of `fid` left it. */
function shapeAfter(h: SharedHarness, r: BuildResponse, fid: string): OccShape {
  const state = r._build_state as BuildState
  const snapshot = state.checkpoints[fid].body_store_snapshot
  return h.table.get<OccShape>(snapshot[BODY].shape as never)
}

describe.skipIf(!oc || !solveBytes)('fillet invalid-result gate (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('refuses the fillet that corrupts the solid, and keeps the body it had', () => {
    const h = new SharedHarness(oc!)
    const r = h.run({ features })

    // The corrupting pick fails loudly instead of reporting a healthy feature.
    expect(statusOf(r, BAD_FILLET)).toBe('exception')
    const message = (r.result as Record<string, { exception?: string }>)[BAD_FILLET].exception ?? ''
    expect(message).toContain('invalid geometry')

    // ... and the body is left as the last good feature built it, not replaced
    // by the corrupt shell. Everything up to that point must still build.
    expect(statusOf(r, EXTRUDE)).toBe('ok')
    expect(statusOf(r, GOOD_FILLET)).toBe('ok')

    const scope = new DisposeScope()
    try {
      const surviving = shapeAfter(h, r, 'hwxVBDxDF7b5EOWhqESDSQlu')
      expect(scope.track(new oc!.BRepCheck_Analyzer(surviving, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('the same picks build once the radius stays inside what the corner admits', () => {
    // The gate rejects a corrupt result, not the fillet itself: at 0.1 the same
    // two picks produce a sound solid, so the refusal above is about geometry
    // and not about this feature being unbuildable.
    const relaxed = features.map((f) =>
      f.id === BAD_FILLET ? { ...f, fillet: { ...(f.fillet as object), radius: 0.1 } } : f,
    )
    const h = new SharedHarness(oc!)
    const r = h.run({ features: relaxed })

    expect(statusOf(r, BAD_FILLET)).not.toBe('exception')

    const scope = new DisposeScope()
    try {
      const built = shapeAfter(h, r, BAD_FILLET)
      expect(scope.track(new oc!.BRepCheck_Analyzer(built, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
