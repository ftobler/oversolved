// The fillet_corners applier: trims both sides of each named corner to the
// tangent points, mints one tangent arc per corner, consumes the joint
// coincidents and authors the four replacement relations. The corner math is
// pinned in utils/geometry/__tests__/filletCorner.test.ts; these pin the document
// write and the constraint policy.

import { describe, it, expect } from 'vitest'
import type { FilletCorner, PartDoc, SketchFeature } from '@/types/cad'
import { applyFilletCorners, planFilletCorners } from '@/utils/yamlMutations'
import { applyAddConstraint } from '@/utils/yamlMutations/sketch'
import { applyAddRect } from '@/utils/yamlMutations/sketchSugar'
import { sketchAt } from '@/testing/featureAccess'

const feat = (doc: PartDoc) => {
  const f = sketchAt(doc)
  return { entities: f.entities!, initial: f.initial!, constraints: f.constraints! }
}

const copy = (doc: PartDoc): PartDoc => JSON.parse(JSON.stringify(doc)) as PartDoc

// A 80 x 60 counter-clockwise rectangle with the four joint coincidents.
function rectDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'b', kind: 'line' },
        { id: 'r', kind: 'line' },
        { id: 't', kind: 'line' },
        { id: 'l', kind: 'line' },
      ],
      initial: {
        b: [0, 0, 80, 0],
        r: [80, 0, 80, 60],
        t: [80, 60, 0, 60],
        l: [0, 60, 0, 0],
      },
      constraints: [
        { id: 'k_bl', kind: 'coincident', a: '$bstart', b: '$lend' },
        { id: 'k_br', kind: 'coincident', a: '$bend', b: '$rstart' },
        { id: 'k_tr', kind: 'coincident', a: '$rend', b: '$tstart' },
        { id: 'k_tl', kind: 'coincident', a: '$tend', b: '$lstart' },
      ],
    }],
  }
}

const RECT_CORNERS: FilletCorner[] = [
  { a: 'b', aVertex: 'start', b: 'l', bVertex: 'end' },
  { a: 'b', aVertex: 'end', b: 'r', bVertex: 'start' },
  { a: 'r', aVertex: 'end', b: 't', bVertex: 'start' },
  { a: 't', aVertex: 'end', b: 'l', bVertex: 'start' },
]

describe('applyFilletCorners rectangle', () => {
  it('trims four sides, adds four arcs and replaces the four joints', () => {
    const doc = rectDoc()
    applyFilletCorners(doc, 'sk', 5, RECT_CORNERS)
    const f = feat(doc)

    expect(f.entities).toHaveLength(8)
    expect(new Set(f.entities.map(e => e.id)).size).toBe(8)
    expect(f.entities.filter(e => e.kind === 'arc')).toHaveLength(4)

    // Every side shrank by the tangent distance at both ends.
    expect(f.initial.b).toEqual([5, 0, 75, 0])
    expect(f.initial.r).toEqual([80, 5, 80, 55])
    expect(f.initial.t).toEqual([75, 60, 5, 60])
    expect(f.initial.l).toEqual([0, 55, 0, 5])

    const arcs = f.entities.filter(e => e.kind === 'arc')
    const arcParams = arcs.map(e => f.initial[e.id])
    expect(arcParams).toHaveLength(4)
    for (const params of arcParams) {
      expect(params[2]).toBe(5)
      expect(params[4] - params[3]).toBeCloseTo(90, 6)
    }
    const centres = arcParams.map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    expect(centres).toEqual([[5, 5], [5, 55], [75, 5], [75, 55]])

    // The four joint coincidents are consumed; eight endpoint coincidents and
    // eight line-arc tangents replace them, all with unique ids. Each arc also
    // gets the radius that keeps the step from leaving a free radius, and the
    // four bare lines had no direction constraint, so the consumed corners'
    // relative angles are re-stated (three independent angles for four corners).
    expect(f.constraints).toHaveLength(23)
    expect(new Set(f.constraints.map(c => c.id)).size).toBe(23)
    expect(f.constraints.filter(c => c.kind === 'coincident')).toHaveLength(8)
    expect(f.constraints.filter(c => c.kind === 'tangent')).toHaveLength(8)
    expect(f.constraints.filter(c => c.kind === 'radius')).toHaveLength(4)
    expect(f.constraints.filter(c => c.kind === 'angle')).toHaveLength(3)
    for (const c of f.constraints) {
      if (c.kind === 'radius') expect(c.value).toBe(5)
      if (c.kind === 'angle') expect(c.value).toBe(90)
    }
    for (const id of ['k_bl', 'k_br', 'k_tr', 'k_tl']) {
      expect(f.constraints.some(c => c.id === id)).toBe(false)
    }
  })

  it('leaves the document byte-identical when a later corner in the step is bad', () => {
    const doc = rectDoc()
    // The last corner names a line that is not there, so no earlier corner may
    // have trimmed anything or minted an arc.
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 5, [
      ...RECT_CORNERS.slice(0, 3),
      { a: 'b', aVertex: 'start', b: 'missing', bVertex: 'start' },
    ])
    expect(doc).toEqual(before)
  })
})

describe('applyFilletCorners side dimensions', () => {
  // A dimensioned rectangle: the sugar adds the four joint coincidents, two
  // equal-length pairs, horizontal on the bottom, vertical on the right and a
  // length on the bottom and the right. It is the fully constrained case the
  // stale lengths broke.
  //
  // The rect's own corner pin cannot be used: `fillet_corners` refuses a
  // dimension or coincident on a trimmed endpoint, and this step trims all four
  // corners. A fixed origin point plus the two line distances to it pins the
  // same translation without naming a trimmed vertex.
  function dimensionedRect(): { doc: PartDoc; ids: string[] } {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [], initial: {}, constraints: [],
      }],
    }
    applyAddRect(doc, 'sk', [0, 0], [40, 30], null, null, undefined, true)
    const f = feat(doc)
    const ids = f.entities!.map(e => e.id)
    f.entities!.push({ id: 'o', kind: 'point' })
    f.initial!.o = [0, 0]
    applyAddConstraint(doc, 'sk', 'fixed', ['vertex:sk:o:xy'])
    applyAddConstraint(doc, 'sk', 'line_distance', [`entity:sk:${ids[0]}`, 'vertex:sk:o:xy'], 0)
    applyAddConstraint(doc, 'sk', 'line_distance', [`entity:sk:${ids[1]}`, 'vertex:sk:o:xy'], 0)
    return { doc, ids }
  }

  const cornersOf = (ids: string[]): FilletCorner[] => {
    const [b, r, t, l] = ids
    return [
      { a: b, aVertex: 'start', b: l, bVertex: 'end' },
      { a: b, aVertex: 'end', b: r, bVertex: 'start' },
      { a: r, aVertex: 'end', b: t, bVertex: 'start' },
      { a: t, aVertex: 'end', b: l, bVertex: 'start' },
    ]
  }

  it('replaces a trimmed side length with the overall size, and names both ids', () => {
    const { doc, ids } = dimensionedRect()
    const before = feat(doc)
    const lengths = before.constraints!.filter(c => c.kind === 'length')
    expect(lengths.map(c => c.value).sort((a, b) => a! - b!)).toEqual([30, 40])

    const plan = planFilletCorners(sketchAt(doc) as SketchFeature, 3, cornersOf(ids))
    expect('corners' in plan).toBe(true)
    if (!('corners' in plan)) return
    expect(plan.removeConstraintIds.sort()).toEqual(lengths.map(c => c.id).sort())
    const replacements = plan.addConstraints.filter(c => c.kind === 'line_distance' || c.kind === 'length')
    expect(replacements.map(c => c.value).sort((a, b) => a! - b!)).toEqual([30, 40])
    expect(replacements.every(c => c.kind === 'line_distance')).toBe(true)
    expect(replacements.every(c => c.sign === 1 || c.sign === -1)).toBe(true)
    // Each replacement names the perpendicular side pair that spans the size.
    for (const c of replacements) {
      expect(c.targets).toHaveLength(2)
      expect(c.targets[0]).toMatch(/^entity:sk:/)
      expect(c.targets[1]).toMatch(/^vertex:sk:.*:start$/)
    }
  })

  it('leaves no length dimension that exceeds its line straight run', () => {
    const { doc, ids } = dimensionedRect()
    applyFilletCorners(doc, 'sk', 3, cornersOf(ids))
    const f = feat(doc)
    const runs = new Map<string, number>()
    for (const entity of f.entities!) {
      if (entity.kind !== 'line') continue
      const p = f.initial[entity.id]
      runs.set(entity.id, Math.hypot(p[2] - p[0], p[3] - p[1]))
    }
    for (const c of f.constraints!) {
      if (c.kind !== 'length' || typeof c.value !== 'number') continue
      const target = String(c.target).replace(/^\$/, '')
      expect(c.value).toBeLessThanOrEqual(runs.get(target)! + 1e-6)
    }
  })

  it('keeps the corner direction the joint coincidents carried', () => {
    const { doc, ids } = dimensionedRect()
    applyFilletCorners(doc, 'sk', 3, cornersOf(ids))
    const f = feat(doc)
    // The right side and the top side had no axis constraint of their own; the
    // bottom is horizontal and the right vertical, so the fixer adds the
    // matching axis to the free sides.
    const on = (id: string, kind: string) =>
      f.constraints!.some(c => c.kind === kind && String(c.target).replace(/^\$/, '') === id)
    expect(on(ids[2], 'horizontal')).toBe(true)
    expect(on(ids[3], 'vertical')).toBe(true)
    expect(f.constraints!.filter(c => c.kind === 'angle')).toHaveLength(0)
  })

  it('rewrites a triangle side to its straight run when no overall pair exists', () => {
    // A triangle has no pair of parallel perpendicular sides to measure an
    // overall size between, so the straight run is the honest replacement.
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'ab', kind: 'line' },
          { id: 'bc', kind: 'line' },
          { id: 'ca', kind: 'line' },
        ],
        initial: {
          ab: [0, 0, 10, 0],
          bc: [10, 0, 5, 8],
          ca: [5, 8, 0, 0],
        },
        constraints: [
          { id: 'k_a', kind: 'coincident', a: '$abstart', b: '$caend' },
          { id: 'k_b', kind: 'coincident', a: '$abend', b: '$bcstart' },
          { id: 'k_c', kind: 'coincident', a: '$bcend', b: '$castart' },
          { id: 'k_len', kind: 'length', target: '$ab', value: 10 },
        ],
      }],
    }
    applyFilletCorners(doc, 'sk', 1, [{ a: 'ab', aVertex: 'end', b: 'bc', bVertex: 'start' }])
    const after = feat(doc)
    expect(after.constraints!.some(c => c.id === 'k_len')).toBe(false)
    const replacement = after.constraints!.filter(c => c.kind === 'length')
    expect(replacement).toHaveLength(1)
    // 10 - 1 / tan(atan2(8, 5) / 2) is the straight run the trim leaves.
    const theta = Math.atan2(8, 5)
    expect(replacement[0].value).toBeCloseTo(10 - 1 / Math.tan(theta / 2), 6)
  })

  it('rewrites a one-sided trim broken equal_length pair as parallel', () => {
    const { doc, ids } = dimensionedRect()
    const before = feat(doc)
    const equalIds = before.constraints!.filter(c => c.kind === 'equal_length').map(c => c.id)
    expect(equalIds).toHaveLength(2)
    applyFilletCorners(doc, 'sk', 3, [cornersOf(ids)[0]])
    const after = feat(doc)
    for (const id of equalIds) {
      expect(after.constraints!.some(c => c.id === id)).toBe(false)
    }
    expect(after.constraints!.filter(c => c.kind === 'parallel')).toHaveLength(2)
  })

  it('leaves the document byte-identical when a corner refuses after a rewrite was planned', () => {
    const { doc, ids } = dimensionedRect()
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 100, cornersOf(ids))
    expect(doc).toEqual(before)
  })
})

describe('applyFilletCorners refusals', () => {
  it('refuses an arc side by name and leaves the document untouched', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'l', kind: 'line' }, { id: 'a', kind: 'arc' }],
        initial: { l: [0, 0, 10, 0], a: [10, 5, 5, 270, 90] },
        constraints: [],
      }],
    }
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 2, [{ a: 'l', aVertex: 'end', b: 'a', bVertex: 'start' }])
    expect(doc).toEqual(before)
  })

  it('refuses a fixed on the trimmed endpoint by constraint id', () => {
    const doc = rectDoc()
    if (doc.features![0].kind === 'sketch') {
      doc.features![0].constraints!.push(
        { id: 'k_fixed', kind: 'fixed', target: '$bstart', x: 0, y: 0 },
      )
    }
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 5, RECT_CORNERS)
    expect(doc).toEqual(before)
  })

  it('refuses a dimension on the trimmed endpoint by constraint id', () => {
    const doc = rectDoc()
    if (doc.features![0].kind === 'sketch') {
      doc.features![0].constraints!.push(
        { id: 'k_dist', kind: 'point_distance', a: '$bstart', b: '$rstart', value: 80 },
      )
    }
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 5, RECT_CORNERS)
    expect(doc).toEqual(before)
  })

  it('refuses a second coincident on a trimmed endpoint', () => {
    const doc = rectDoc()
    if (doc.features![0].kind === 'sketch') {
      doc.features![0].constraints!.push(
        { id: 'k_second', kind: 'coincident', a: '$bstart', b: '$tstart' },
      )
    }
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 5, RECT_CORNERS)
    expect(doc).toEqual(before)
  })

  it('refuses a tangent between the two sides', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }],
        initial: { a: [10, 0, 0, 0], b: [0, 0, 0, 10] },
        constraints: [{ id: 'k_tan', kind: 'tangent', a: '$a', b: '$b' }],
      }],
    }
    const before = copy(doc)
    applyFilletCorners(doc, 'sk', 2, [{ a: 'a', aVertex: 'end', b: 'b', bVertex: 'start' }])
    expect(doc).toEqual(before)
  })
})

describe('applyFilletCorners coordinate-only corner', () => {
  it('applies cleanly with no joint constraint to delete', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }],
        initial: { a: [10, 0, 0, 0], b: [0, 0, 0, 10] },
        constraints: [],
      }],
    }
    applyFilletCorners(doc, 'sk', 2, [{ a: 'a', aVertex: 'end', b: 'b', bVertex: 'start' }])
    const f = feat(doc)
    expect(f.entities).toHaveLength(3)
    expect(f.entities.filter(e => e.kind === 'arc')).toHaveLength(1)
    expect(f.initial.a).toEqual([10, 0, 2, 0])
    expect(f.initial.b).toEqual([0, 2, 0, 10])
    // Two endpoint coincidents, two tangents, the arc's radius and the angle
    // that the consumed corner no longer states.
    expect(f.constraints).toHaveLength(6)
    expect(f.constraints.map(c => c.kind).sort()).toEqual(
      ['angle', 'coincident', 'coincident', 'radius', 'tangent', 'tangent'],
    )
  })

  it('carries the construction flag only when both sides are construction', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'a', kind: 'line', construction: true }, { id: 'b', kind: 'line', construction: true }],
        initial: { a: [10, 0, 0, 0], b: [0, 0, 0, 10] },
        constraints: [],
      }],
    }
    applyFilletCorners(doc, 'sk', 2, [{ a: 'a', aVertex: 'end', b: 'b', bVertex: 'start' }])
    const arc = feat(doc).entities.find(e => e.kind === 'arc')
    expect(arc?.construction).toBe(true)
  })
})
