import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { partDocToSketches } from './partDocToSketches'

describe('partDocToSketches', () => {
  it('resolves $-form sketch-local refs to dict form', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'bottom', kind: 'line' },
          { id: 'right', kind: 'line' },
        ],
        initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10] },
        constraints: [
          { id: 'c1', kind: 'coincident', a: '$bottomend', b: '$rightstart' },
          { id: 'c2', kind: 'horizontal', target: '$bottom' },
          { id: 'c3', kind: 'length', target: '$bottom', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'bottom', point: 'end' },
      b: { entity: 'right', point: 'start' },
    })
    expect(c[1]).toMatchObject({ kind: 'horizontal', target: { entity: 'bottom' } })
    expect(c[2]).toMatchObject({ kind: 'length', target: { entity: 'bottom' }, value: 10 })
  })

  it('drops constraints whose refs do not resolve locally (mirrors backend filter)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'p1', kind: 'point' }],
        initial: { p1: [0, 0] },
        constraints: [
          { id: 'keep', kind: 'fixed', target: '$p1', x: 0, y: 0 },
          // references a non-local / ancestral entity -> dropped
          { id: 'drop', kind: 'coincident', a: '$p1', b: '$nonexistentstart' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    const ids = sketches[0].sketch.constraints.map((c) => c.id)
    expect(ids).toEqual(['keep'])
  })

  it('skips projection and center_rect sketches', () => {
    const features: PartFeature[] = [
      {
        id: 'proj',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line', source: '@sketch0/line1' }],
        initial: {},
        constraints: [],
      },
      {
        id: 'sugar',
        kind: 'sketch',
        entities: [{ id: 'r1', kind: 'center_rect' }],
        initial: {},
        constraints: [],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped.map((s) => s.featureId).sort()).toEqual(['proj', 'sugar'])
  })

  it('resolves @builtin_origin to external_xy:[0,0]', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'c1', kind: 'circle' }],
        initial: { c1: [0, 0, 5] },
        constraints: [
          { id: 'c_coincident', kind: 'coincident', a: '$c1center', b: '@builtin_origin' },
          { id: 'c_diameter', kind: 'diameter', target: '$c1', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'c1', point: 'center' },
      b: { external_xy: [0, 0] },
    })
    expect(c[1]).toMatchObject({ kind: 'diameter', target: { entity: 'c1' }, value: 10 })
  })

  it('expands an ngon sugar constraint to equal_length + angle (not dropped)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'l0', kind: 'line' }, { id: 'l1', kind: 'line' },
          { id: 'l2', kind: 'line' }, { id: 'l3', kind: 'line' },
        ],
        initial: { l0: [1, 0, 0, 1], l1: [0, 1, -1, 0], l2: [-1, 0, 0, -1], l3: [0, -1, 1, 0] },
        constraints: [
          { id: 'ng', kind: 'ngon', refs: ['$l0', '$l1', '$l2', '$l3'] },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    // 4 sides -> 3 equal_length + (4-3)=1 angle; no raw `ngon` survives.
    expect(cs.filter((c) => c.kind === 'ngon')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'equal_length')).toHaveLength(3)
    const angles = cs.filter((c) => c.kind === 'angle')
    expect(angles).toHaveLength(1)
    expect(angles[0]).toMatchObject({ value: 90, a: { entity: 'l0' }, b: { entity: 'l1' } })
    expect(cs[0]).toMatchObject({ kind: 'equal_length', a: { entity: 'l0' }, b: { entity: 'l1' } })
  })

  it('expands an offset line constraint to parallel + line_distance', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'src', kind: 'line' }, { id: 'dst', kind: 'line' }],
        initial: { src: [0, 0, 10, 0], dst: [0, 0, 10, 0] },
        constraints: [{ id: 'off', kind: 'offset', a: '$src', b: '$dst', value: 5 }],
      },
    ]
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs.filter((c) => c.kind === 'offset')).toHaveLength(0)
    expect(cs.find((c) => c.kind === 'parallel')).toMatchObject({
      a: { entity: 'src' }, b: { entity: 'dst' },
    })
    expect(cs.find((c) => c.kind === 'line_distance')).toMatchObject({
      a: { entity: 'src' }, b: { entity: 'dst', point: 'start' }, value: 5,
    })
  })

  it('expands an offset circle constraint to concentric + diameter', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'src', kind: 'circle' }, { id: 'dst', kind: 'circle' }],
        initial: { src: [0, 0, 5], dst: [0, 0, 5] },
        constraints: [{ id: 'off', kind: 'offset', a: '$src', b: '$dst', value: 3 }],
      },
    ]
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs.find((c) => c.kind === 'concentric')).toMatchObject({
      a: { entity: 'src' }, b: { entity: 'dst' },
    })
    expect(cs.find((c) => c.kind === 'diameter')).toMatchObject({
      target: { entity: 'dst' }, value: 16,  // 2 * (5 + 3)
    })
  })

  it('leaves an offset spline as a free copy (no primitive constraints emitted)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'src', kind: 'spline' }, { id: 'dst', kind: 'spline' }],
        initial: { src: [0, 0, 1, 1, 2, 1, 3, 0], dst: [0, 0, 1, 1, 2, 1, 3, 0] },
        constraints: [{ id: 'off', kind: 'offset', a: '$src', b: '$dst', value: 2 }],
      },
    ]
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs).toHaveLength(0)  // spline offset has no clean lowering
  })

  it('ignores non-sketch features', () => {
    const features: PartFeature[] = [
      { id: 'ex1', kind: 'extrude', extrude: undefined } as unknown as PartFeature,
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped).toHaveLength(0)
  })
})
