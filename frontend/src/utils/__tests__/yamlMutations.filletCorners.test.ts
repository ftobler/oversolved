// The fillet_corners applier: trims both sides of each named corner to the
// tangent points, mints one tangent arc per corner, consumes the joint
// coincidents and authors the four replacement relations. The corner math is
// pinned in utils/geometry/__tests__/filletCorner.test.ts; these pin the document
// write and the constraint policy.

import { describe, it, expect } from 'vitest'
import type { FilletCorner, PartDoc } from '@/types/cad'
import { applyFilletCorners } from '@/utils/yamlMutations'
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
    // eight line-arc tangents replace them, all with unique ids.
    expect(f.constraints).toHaveLength(16)
    expect(new Set(f.constraints.map(c => c.id)).size).toBe(16)
    expect(f.constraints.filter(c => c.kind === 'coincident')).toHaveLength(8)
    expect(f.constraints.filter(c => c.kind === 'tangent')).toHaveLength(8)
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
    expect(f.constraints).toHaveLength(4)
    expect(f.constraints.map(c => c.kind).sort()).toEqual(['coincident', 'coincident', 'tangent', 'tangent'])
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
