// @vitest-environment node
//
// Naming the consumed END face in a fillet/chamfer refusal (plan
// bug-fillet-end-cap-sliver, part A).
//
// A straight blend whose setback runs past a small end face -- a planar face
// that touches the picked edge only at one vertex -- makes OCC refuse with a
// bare build_failed. Nothing measured that face before, so the user got the
// "try a smaller radius" hint, which is wrong twice over: the radius is what
// they asked for, and in the reported enclosure only r <= 1.0627 of r9 builds
// while r9 is exactly the rounding that removes the overhang.
//
// Real kernel, gated like the other Real suites. The near-tangent fixture that
// must NOT be claimed by this diagnosis also runs in
// drive/__tests__/precisionAuditReal.test.ts, which pins the corner's own
// message through the whole drive path.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DisposeScope } from '../../occ/disposeScope'
import { makeEdgeIndexCache, resolveEdgesWithIndex } from '../filletChamfer'
import { endFaceDiagnosis } from '../edgeFailureDiagnosis'
import { makeFilletPrismFallback, setEndFacePrismEnabledForTest } from '../endFaceBlend'
import { tangentChain } from '../tangentChain'
import { bodyAt, enclosureBase, END_FACE_LEG } from './enclosureFixture'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

describe.skipIf(!oc || !solveBytes)('fillet end-face refusal naming (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })
  afterEach(() => setEndFacePrismEnabledForTest(true))

  it('names the 1.0627 end face and never sends the user to a smaller radius', () => {
    // The fallback is off here so the refusal path is the one under test; with
    // it on the same pick builds (the prism test pins that).
    setEndFacePrismEnabledForTest(false)
    const { spec, lipEdges } = enclosureBase(h)
    spec.features.push({ id: 'fi2', kind: 'fillet', fillet: { edges: lipEdges, radius: 2 } })
    const res = h.res(h.run(spec), 'fi2')
    expect(res.status).toBe('exception')
    const message = String(res.exception ?? '')
    // The leg is 9 - sqrt(63) == 1.0627; the message carries the measured width
    // with the file's six-significant-digit convention.
    expect(message).toContain(`consumes the ${Number(END_FACE_LEG.toPrecision(6))} end face`)
    expect(message).toContain('fillet_corners')
    expect(message).not.toContain('try a smaller radius')
    expect(message).not.toContain('no reason from the kernel')

    // The measured limit is the reported threshold, not a guess: the finding
    // measured r1.0 building and r1.1 refusing.
    spec.features[spec.features.length - 1] = { id: 'fi2', kind: 'fillet', fillet: { edges: lipEdges, radius: 1.0 } }
    expect(h.res(h.run(spec), 'fi2').status).toBe('ok')
  }, 180_000)

  it('a chamfer distance past the same end face names it too', () => {
    setEndFacePrismEnabledForTest(false)
    const { spec, lipEdges } = enclosureBase(h)
    spec.features.push({ id: 'ch1', kind: 'chamfer', chamfer: { edges: lipEdges, distance: 2, kind: 'distance', angle: 45 } })
    const res = h.res(h.run(spec), 'ch1')
    expect(res.status).toBe('exception')
    const message = String(res.exception ?? '')
    expect(message).toContain(`distance 2 consumes the ${Number(END_FACE_LEG.toPrecision(6))} end face`)
    expect(message).toContain('fillet_corners')
    expect(message).not.toContain('try a smaller radius')
  }, 180_000)

  it('does not fire when the end face is the plate top: a plain lip fillets at r2', () => {
    // No r12 on the plate, so the lip sits wholly on it and its edge ends on the
    // big plate top face. That face is not consumed at r2, and the build is a
    // plain success (the fallback is on and must not be involved).
    const { spec, lipEdges } = enclosureBase(h, { cornerFillet: false })
    spec.features.push({ id: 'fi2', kind: 'fillet', fillet: { edges: lipEdges, radius: 2 } })
    const res = h.res(h.run(spec), 'fi2')
    expect(res.status).toBe('ok')
    expect(res.solver_note).toBeUndefined()
  }, 180_000)

  it('a non-square cap is named without a made-up limit, and never gets the fallback', () => {
    // A tapered lip: its side faces are B-spline surfaces on exact planes and its
    // upright edges B-spline curves on exact lines, so both have to be measured
    // rather than trusted by their analytic type. The bottom cap is not square to
    // the picked edge, so no single end-face reach exists; the message says so
    // instead of inventing a number, and the prism cut refuses the edge.
    const { lipEdges, result } = enclosureBase(h, { taper: 10 })
    const body = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const shape = h.table.get<OccShape>(body.shape!)
    const indexFor = makeEdgeIndexCache(oc!, scope, h.table)
    const picked = resolveEdgesWithIndex(oc!, scope, h.table, body, indexFor(body), lipEdges)
    expect(picked).toHaveLength(4)

    const text = endFaceDiagnosis(oc!, scope, shape, picked, { kind: 'fillet', radius: 2 })
    expect(text).toContain('consumes the end face at')
    expect(text).toContain('deg off square')
    expect(text).toContain('fillet_corners')
    // No fabricated "under 1.06 builds" number on a face that has no reach.
    expect(text).not.toMatch(/consumes the [\d.]+ end face/)

    const fallback = makeFilletPrismFallback(2, 'fi2')
    for (const edge of picked) expect(fallback.qualifies(oc!, scope, shape, edge)).toBe(false)
    scope.dispose()
  }, 180_000)

  it('a tangent-chain pick is never handed to the prism cut', () => {
    // The plate's boundary is a rounded rectangle: each straight side is
    // G1-continuous with the r12 corner arc beside it. OCC follows that joint, a
    // prism cannot, so every edge whose chain is longer than itself is refused.
    const { result } = enclosureBase(h)
    const body = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const shape = h.table.get<OccShape>(body.shape!)
    const indexFor = makeEdgeIndexCache(oc!, scope, h.table)
    const plateQueries = ((h.body(result, 'body_ex1').edge_queries as string[]) ?? []).filter((q) => q.includes('@ex1@'))
    const picked = resolveEdgesWithIndex(oc!, scope, h.table, body, indexFor(body), plateQueries)
    const fallback = makeFilletPrismFallback(2, 'fi2')
    let chained = 0
    let qualified = 0
    for (const edge of picked) {
      if (tangentChain(oc!, shape, [edge]).chain <= 1) continue
      chained++
      if (fallback.qualifies(oc!, scope, shape, edge)) qualified++
    }
    expect(chained).toBeGreaterThan(0)
    expect(qualified).toBe(0)
    scope.dispose()
  }, 180_000)
})
