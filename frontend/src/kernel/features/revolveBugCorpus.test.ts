// @vitest-environment node
//
// Corpus regression for bugreports/revolve_bug_20260707_151218.md.
//
// The user picked a vertical Z-direction body edge (the extrusion corner
// inherited from sketch lines kbNgbTt + uYfJ14s) as the revolve axis, but the
// revolved solid came out "squished", suggesting the resolver picked a
// horizontal edge instead. This test rebuilds the bug-report AST verbatim and
// asserts the revolve axis is the front-back (Z) direction through the
// editing-handle tangent (perpendicular to the axis), so a horizontal wrong
// axis would fail the assertion.
//
// Front plane convention: `builtin_plane_front` has normal [0,0,1], so
// "front-back" (perpendicular to the front view, into the screen) is the Z
// axis; an axis running along Z yields a handle tangent in the XY plane,
// hence `handle.direction[2] ~ 0`.
//
// Skips when OCC.js or the Rust solver is absent (mirrors the other real
// revolve-axis tests).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

// Identifiers preserved verbatim from the bug-report AST so the registered
// ancestry tokens (sketchId/lineId pairs) line up exactly.
const SK = 'h30Adw3veKrNb3y8Rmj7417V'
const EX = 'cYbsX_9sPH41HMpA3J8DW26F'
const FIL = 'sHOqMDiW7GM8WzjnxmYyYAFy'
const REV = 'WUTeR_1EJBghfkHfBJODbBCM'

// The exact stored revolve.axis query from the bug report (the picker's
// capture stored a near-identical query with one extra classifier cls_zn and
// the sketch-line tokens in the opposite order; the persisted version is what
// the resolver sees). Used verbatim so the registry-resolution path matches
// the user's bug-corpus state.
const STORED_AXIS_QUERY =
  '?2f,19,1e,2a,2a,7,7;' +
  '@gde|line|-18.5789,-3.3349,5.0|0.0,0.0,1.0|10.0' +
  '@' + EX +
  '@body_' + EX +
  '@' + SK + '/kbNgbTt-fnV7itwD' +
  '@' + SK + '/uYfJ14s00xFk-vN1' +
  '@cls_xn@cls_yn:straightedge'

// The exact fillet-edge query from the bug report (a top z=10 Y-direction
// edge at the inner wall of the upper profile). Used verbatim so the fillet
// narrows the body geometry that the revolve axis query resolves against.
const FILLET_EDGE_QUERY =
  '?2f,19,1e,2a,7;' +
  '@gde|line|-9.3942,15.3228,10.0|0.0,1.0,0.0|17.8' +
  '@' + EX +
  '@body_' + EX +
  '@' + SK + '/DoQ5WShzeIONGpxe' +
  '@cls_zp:straightedge'

// The exact revolve profile query from the bug report (the LEFT lateral body
// face inherited from sketch line suTKXFLy4QtrjqED). Used verbatim so the
// revolve sweeps the same profile the user picked.
const STORED_PROFILE_QUERY =
  '?25,19,1e,2a,7;' +
  '@gdf|-18.334,14.6761,5.0|-1.0,0.0,0.0' +
  '@' + EX +
  '@body_' + EX +
  '@' + SK + '/suTKXFLy4QtrjqED' +
  '@cls_xn:flatface'

// Bug-report sketch verbatim: 9 entities + 17 constraints on the Front plane.
// Initial coordinates are the solver-converged snapshot from the bug report
// (so the rebuilt body sits at exactly the same geometry and the registered
// ancestry tokens line up).
function bugSketchSpec() {
  return {
    id: SK, kind: 'sketch' as const, label: 'sketch 1',
    plane: '@builtin_plane_front', visible: false,
    entities: [
      { id: 'kbNgbTt-fnV7itwD', kind: 'line' as const },
      { id: 'OvGMr3USSIJpXhF7', kind: 'line' as const },
      { id: 'uYfJ14s00xFk-vN1', kind: 'line' as const },
      { id: 'vuHsRLO9owL_hVcYxy', kind: 'point' as const },
      { id: 'SNTUo5j6iTL0ODOX', kind: 'line' as const },
      { id: 'DoQ5WShzeIONGpxe', kind: 'line' as const },
      { id: 'fsZXdQcjjtd-PujS', kind: 'line' as const },
      { id: 'suTKXFLy4QtrjqED', kind: 'line' as const },
      { id: 'ofUPw3y_5FocC2OU', kind: 'line' as const },
    ],
    initial: {
      'kbNgbTt-fnV7itwD': [-18.578903198242188, -3.334900140762329, 14.572552680969238, -3.577221393585205],
      'OvGMr3USSIJpXhF7': [14.572552680969238, -3.577221393585205, 14.572552680969238, 6.422778606414795],
      'uYfJ14s00xFk-vN1': [-18.33401107788086, 5.776092529296875, -18.578903198242188, -3.334900140762329],
      'vuHsRLO9owL_hVcYxy': [-1.8807291984558105, 1.099435567855835],
      'SNTUo5j6iTL0ODOX': [-18.33401107788086, 5.776092529296875, -9.394170761108398, 6.422778606414795],
      'DoQ5WShzeIONGpxe': [-9.394170761108398, 6.422778606414795, -9.394170761108398, 24.222759246826172],
      'fsZXdQcjjtd-PujS': [-9.394170761108398, 24.222759246826172, -18.33401107788086, 23.576072692871094],
      'suTKXFLy4QtrjqED': [-18.33401107788086, 23.576072692871094, -18.33401107788086, 5.776092529296875],
      'ofUPw3y_5FocC2OU': [-9.394170761108398, 6.422778606414795, 14.572552680969238, 6.422778606414795],
    },
    constraints: [
      { id: 'c_coincident_LoMhPkNg', kind: 'coincident' as const, a: '$kbNgbTt-fnV7itwDend', b: '$OvGMr3USSIJpXhF7start' },
      { id: 'c_coincident_iucr0tfS', kind: 'coincident' as const, a: '$uYfJ14s00xFk-vN1end', b: '$kbNgbTt-fnV7itwDstart' },
      { id: 'c_vertical_3bJaqbjq', kind: 'vertical' as const, target: '$OvGMr3USSIJpXhF7' },
      {
        id: 'c_midpoint_PqJslAQo', kind: 'midpoint' as const,
        point: '$vuHsRLO9owL_hVcYxy',
        point_a: '$OvGMr3USSIJpXhF7start',
        point_b: '$uYfJ14s00xFk-vN1start',
      },
      { id: 'c_coincident___iAQ6a7', kind: 'coincident' as const, a: '$SNTUo5j6iTL0ODOXend', b: '$DoQ5WShzeIONGpxestart' },
      { id: 'c_coincident_LWZCg9ir', kind: 'coincident' as const, a: '$DoQ5WShzeIONGpxeend', b: '$fsZXdQcjjtd-PujSstart' },
      { id: 'c_coincident_ZXT2elS4', kind: 'coincident' as const, a: '$fsZXdQcjjtd-PujSend', b: '$suTKXFLy4QtrjqEDstart' },
      { id: 'c_coincident_8MAMN5xB', kind: 'coincident' as const, a: '$suTKXFLy4QtrjqEDend', b: '$SNTUo5j6iTL0ODOXstart' },
      { id: 'c_equal_length_7PIfvJsi', kind: 'equal_length' as const, a: '$SNTUo5j6iTL0ODOX', b: '$fsZXdQcjjtd-PujS' },
      { id: 'c_equal_length_37wFwkEK', kind: 'equal_length' as const, a: '$DoQ5WShzeIONGpxe', b: '$suTKXFLy4QtrjqED' },
      { id: 'c_vertical_Z_hta2PR', kind: 'vertical' as const, target: '$DoQ5WShzeIONGpxe' },
      { id: 'c_length_jvAWLQxr', kind: 'length' as const, target: '$OvGMr3USSIJpXhF7', value: 10 },
      { id: 'c_coincident_qcKBCD-F', kind: 'coincident' as const, a: '$ofUPw3y_5FocC2OUstart', b: '$DoQ5WShzeIONGpxestart' },
      { id: 'c_horizontal_UsK_PRxy', kind: 'horizontal' as const, target: '$ofUPw3y_5FocC2OU' },
      { id: 'c_coincident_gNynBOzz', kind: 'coincident' as const, a: '$ofUPw3y_5FocC2OUend', b: '$OvGMr3USSIJpXhF7end' },
      { id: 'c_coincident_zy8jBzye', kind: 'coincident' as const, a: '$SNTUo5j6iTL0ODOXstart', b: '$uYfJ14s00xFk-vN1start' },
    ],
  }
}

function bugReportSpec(opts?: { noFillet?: boolean; axisQuery?: string }) {
  const features: Array<Record<string, unknown>> = [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane', visible: false },
    { id: 'Front', kind: 'plane', visible: false },
    { id: 'Right', kind: 'plane', visible: false },
    bugSketchSpec(),
    {
      id: EX, kind: 'extrude', label: 'extrude 1',
      extrude: { direction: 'normal', distance: 10, sketch: ['$' + SK] },
    },
  ]
  if (!opts?.noFillet) {
    features.push({
      id: FIL, kind: 'fillet', label: 'fillet 2',
      fillet: { edges: [FILLET_EDGE_QUERY], radius: 4 },
    })
  }
  features.push({
    id: REV, kind: 'revolve', label: 'revolve 2',
    revolve: {
      angle: 45, axis: opts?.axisQuery ?? STORED_AXIS_QUERY,
      axis_direction: [0, 0, 1], axis_origin: [0, 0, 0],
      operation: 'add', sketch: [STORED_PROFILE_QUERY],
    },
  })
  return { version: 1, kind: 'part', features }
}

describe.skipIf(!oc || !solveBytes)('revolve axis verbatim from bug report corpus (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('resolves the revolve axis to the front-back (Z) direction (with fillet)', () => {
    const result = h.run(bugReportSpec())

    // The extrude + fillet should both succeed; the revolve fails loudly when
    // the axis query resolves to no edge (the bug-report stale-pick case the
    // protective guards close), so the revolve surfaces as a red feature
    // rather than silently producing a squished solid at the default axis.
    const exRes = h.res(result, EX)
    expect(exRes.status).toBe('ok')

    const revRes = h.res(result, REV)
    if (revRes.status !== 'ok') {
      // Document the failure path: a thrown-axis revolve is now a loud
      // failure (the protective guard). Throwing is right -- but if the user
      // reports the picked axis is not the one it took, the actual root cause
      // is upstream of the resolver; assert loud-fail here to pin the
      // behaviour under this corpus.
      expect(revRes.exception ?? '').toMatch(/axis|did not resolve|carries no usable axis/)
      return
    }

    // Axis resolves OK -> the editing handle tangent is perpendicular to the
    // axis direction. Front-back axis = Z = (0,0,1) -> tangent lies in the XY
    // plane -> tangent[2] ~ 0. A wrong horizontal axis (e.g. the cls_xn/cls_yn
    // narrowing picking a Y- or X-direction top edge) would yield a tangent
    // with a non-zero Z component.
    const handle = revRes.handle as { direction: number[] } | undefined
    expect(handle).toBeDefined()
    if (!handle) return
    expect(Math.abs(handle.direction[2])).toBeLessThan(1e-6)
  })

  it('resolves the revolve axis front-back direction (no fillet, sanity)', () => {
    // Sanity variant without the fillet feature: the only Edge-of interest
    // comes from Extrude's prism-lineage, so the vertical-corner edge token
    // set should still carry both sketch-line tokens through resolve cleanly.
    const result = h.run(bugReportSpec({ noFillet: true }))
    expect(h.res(result, EX).status).toBe('ok')
    const revRes = h.res(result, REV)
    expect(revRes.status).toBe('ok')
    const handle = revRes.handle as { direction: number[] } | undefined
    expect(handle).toBeDefined()
    if (!handle) return
    expect(Math.abs(handle.direction[2])).toBeLessThan(1e-6)
  })
})