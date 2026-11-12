// @vitest-environment node
//
// The real-solver guard on fillet_corners' meaning: a fully constrained,
// dimensioned rectangle stays fully constrained and keeps its 40 x 30 outline
// after all four corners are rounded, and a triangle corner's angle survives
// the trim. These are the behaviours the old applier lost: it kept the stale
// side lengths and stated no corner direction, so the solver collapsed the arcs
// and skewed the profile (the enclosure practice run).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FilletCorner, PartDoc, SketchFeature } from '@/types/cad'
import { applyFilletCorners } from '@/utils/yamlMutations'
import { applyAddConstraint } from '@/utils/yamlMutations/sketch'
import { applyAddRect } from '@/utils/yamlMutations/sketchSugar'
import { setSketchSolver, setSketchTopology, solveSketch } from '@/kernel/features/sketch'
import { initGlobalRepo } from '@/kernel/query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { sketchAt } from '@/testing/featureAccess'

const solveBytes = loadSolver()
const topologyBytes = loadTopology()

const emptySketchDoc = (id = 'sk'): PartDoc => ({
  features: [{
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [], initial: {}, constraints: [],
  }],
})

const featureOf = (doc: PartDoc): SketchFeature => sketchAt(doc) as SketchFeature

const solve = (doc: PartDoc) =>
  solveSketch(featureOf(doc) as unknown as Record<string, unknown>, initGlobalRepo(), {})

/** The 40 x 30 rect from the applier test, fully constrained by the sugar's
 *  dimensions plus a fixed origin point and two line distances to it. The
 *  distances name whole lines, so no dimension sits on a trimmed endpoint. */
function dimensionedRect(): { doc: PartDoc; ids: string[] } {
  const doc = emptySketchDoc()
  applyAddRect(doc, 'sk', [0, 0], [40, 30], null, null, undefined, true)
  const f = featureOf(doc)
  const ids = f.entities!.map(e => e.id)
  f.entities!.push({ id: 'o', kind: 'point' })
  f.initial!.o = [0, 0]
  applyAddConstraint(doc, 'sk', 'fixed', ['vertex:sk:o:xy'])
  applyAddConstraint(doc, 'sk', 'line_distance', [`entity:sk:${ids[0]}`, 'vertex:sk:o:xy'], 0)
  applyAddConstraint(doc, 'sk', 'line_distance', [`entity:sk:${ids[1]}`, 'vertex:sk:o:xy'], 40)
  return { doc, ids }
}

function rectCorners(ids: string[]): FilletCorner[] {
  const [b, r, t, l] = ids
  return [
    { a: b, aVertex: 'start', b: l, bVertex: 'end' },
    { a: b, aVertex: 'end', b: r, bVertex: 'start' },
    { a: r, aVertex: 'end', b: t, bVertex: 'start' },
    { a: t, aVertex: 'end', b: l, bVertex: 'start' },
  ]
}

function bboxOf(doc: PartDoc): [number, number, number, number] {
  const f = featureOf(doc)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const entity of f.entities ?? []) {
    if (entity.kind !== 'line') continue
    const p = f.initial![entity.id]
    for (const [x, y] of [[p[0], p[1]], [p[2], p[3]]] as const) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return [minX, minY, maxX, maxY]
}

const arcRadii = (doc: PartDoc): number[] =>
  (featureOf(doc).entities ?? [])
    .filter(entity => entity.kind === 'arc')
    .map(entity => featureOf(doc).initial![entity.id][2])

const directionAngle = (p: number[], q: number[]): number => {
  const dp = [p[2] - p[0], p[3] - p[1]]
  const dq = [q[2] - q[0], q[3] - q[1]]
  const cosine = (dp[0] * dq[0] + dp[1] * dq[1])
    / (Math.hypot(dp[0], dp[1]) * Math.hypot(dq[0], dq[1]))
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

describe.skipIf(!solveBytes)('fillet_corners keeps a constrained sketch constrained', () => {
  beforeAll(() => {
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
  })
  afterAll(() => {
    setSketchSolver(null)
    setSketchTopology(null)
  })

  it('four corners at r3 leave a fully constrained 40 x 30 rounded rect', () => {
    const { doc, ids } = dimensionedRect()
    const before = solve(doc)
    expect(before.status).toBe('fully_constrained')
    expect(before.dof).toBe(0)

    applyFilletCorners(doc, 'sk', 3, rectCorners(ids))
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    for (const radius of arcRadii(doc)) expect(radius).toBeCloseTo(3, 6)
    expect(bboxOf(doc)).toEqual([0, 0, 40, 30])

    // The top is horizontal and the left vertical: the corner directions the
    // consumed coincidents carried are stated explicitly.
    const f = featureOf(doc)
    const byId = new Map(f.entities!.map(e => [e.id, e]))
    const axis = (kind: string, id: string) => (f.constraints ?? []).some(
      c => c.kind === kind && String(c.target).replace(/^\$/, '') === id,
    )
    expect(byId.get(ids[2])!.kind).toBe('line')
    expect(axis('horizontal', ids[2])).toBe(true)
    expect(axis('vertical', ids[3])).toBe(true)
  })

  it('one corner keeps the other three joints and stays fully constrained', () => {
    const { doc, ids } = dimensionedRect()
    const joints = (featureOf(doc).constraints ?? []).filter(c => c.kind === 'coincident')
    expect(joints).toHaveLength(4)
    applyFilletCorners(doc, 'sk', 3, [rectCorners(ids)[0]])
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    const left = (featureOf(doc).constraints ?? []).filter(c => c.kind === 'coincident')
    expect(left.length).toBeGreaterThanOrEqual(2)
    expect(bboxOf(doc)).toEqual([0, 0, 40, 30])
  })

  it('keeps the size when a trimmed side is drawn with its direction reversed', () => {
    // The solver's line_distance measures a signed perpendicular offset from
    // the line's own direction. A hand-drawn or converted sketch can store the
    // right side top-to-bottom; the replacement dimension must carry the sign
    // that side implies or it is off by twice the value.
    const doc = emptySketchDoc()
    const f = featureOf(doc)
    f.entities!.push({ id: 'b', kind: 'line' }, { id: 'r', kind: 'line' })
    f.entities!.push({ id: 't', kind: 'line' }, { id: 'l', kind: 'line' })
    f.initial!.b = [0, 0, 40, 0]
    f.initial!.r = [40, 30, 40, 0]
    f.initial!.t = [40, 30, 0, 30]
    f.initial!.l = [0, 30, 0, 0]
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:b:end', 'vertex:sk:r:end'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:r:start', 'vertex:sk:t:start'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:t:end', 'vertex:sk:l:start'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:l:end', 'vertex:sk:b:start'])
    applyAddConstraint(doc, 'sk', 'equal_length', ['entity:sk:b', 'entity:sk:t'])
    applyAddConstraint(doc, 'sk', 'equal_length', ['entity:sk:r', 'entity:sk:l'])
    applyAddConstraint(doc, 'sk', 'horizontal', ['entity:sk:b'])
    applyAddConstraint(doc, 'sk', 'vertical', ['entity:sk:r'])
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:b'], 40)
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:r'], 30)
    f.entities!.push({ id: 'o', kind: 'point' })
    f.initial!.o = [0, 0]
    applyAddConstraint(doc, 'sk', 'fixed', ['vertex:sk:o:xy'])
    applyAddConstraint(doc, 'sk', 'line_distance', ['entity:sk:b', 'vertex:sk:o:xy'], 0)
    applyAddConstraint(doc, 'sk', 'line_distance', ['entity:sk:l', 'vertex:sk:o:xy'], 0)
    expect(solve(doc).status).toBe('fully_constrained')

    applyFilletCorners(doc, 'sk', 3, [
      { a: 'b', aVertex: 'start', b: 'l', bVertex: 'end' },
      { a: 'b', aVertex: 'end', b: 'r', bVertex: 'end' },
      { a: 'r', aVertex: 'start', b: 't', bVertex: 'start' },
      { a: 't', aVertex: 'end', b: 'l', bVertex: 'start' },
    ])
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    for (const radius of arcRadii(doc)) expect(radius).toBeCloseTo(3, 6)
    expect(bboxOf(doc)).toEqual([0, 0, 40, 30])
  })

  it('a 60 degree triangle corner keeps its angle after the trim', () => {
    const doc = emptySketchDoc()
    const f = featureOf(doc)
    f.entities!.push({ id: 'ab', kind: 'line' }, { id: 'bc', kind: 'line' }, { id: 'ca', kind: 'line' })
    f.initial!.ab = [0, 0, 10, 0]
    f.initial!.bc = [10, 0, 5, 8.660254037844387]
    f.initial!.ca = [5, 8.660254037844387, 0, 0]
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:ca:end', 'vertex:sk:ab:start'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:ab:end', 'vertex:sk:bc:start'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:bc:end', 'vertex:sk:ca:start'])
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:ab'], 10)
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:bc'], 10)
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:ca'], 10)
    applyAddConstraint(doc, 'sk', 'horizontal', ['entity:sk:ab'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:ab:start', '@builtin_origin'])

    const before = solve(doc)
    expect(before.status).toBe('fully_constrained')
    // The stored direction angle, not the interior wedge: ab runs +x and bc
    // runs up-left, so the pair reads 120 while the corner subtends 60. The
    // fillet must keep whichever the sketch had.
    const beforeAngle = directionAngle(f.initial!.ab, f.initial!.bc)
    expect(beforeAngle).toBeCloseTo(120, 3)

    applyFilletCorners(doc, 'sk', 1, [{ a: 'ab', aVertex: 'end', b: 'bc', bVertex: 'start' }])
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(arcRadii(doc)[0]).toBeCloseTo(1, 6)
    expect(directionAngle(f.initial!.ab, f.initial!.bc)).toBeCloseTo(beforeAngle, 3)
  })
})
