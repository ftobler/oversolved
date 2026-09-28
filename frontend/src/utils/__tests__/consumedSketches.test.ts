import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { allConsumedSketchIds, consumedSketchIds } from '@/utils/query/consumedSketches'

const sk = (id: string): PartFeature => ({ id, kind: 'sketch' })
const ex = (id: string, profiles: string[]): PartFeature => ({ id, kind: 'extrude', extrude: { sketch: profiles, distance: 1 } })

// The side face of an extruded rectangle, as the real kernel names it: the
// sketch edge that swept it sits in the ancestry next to the extrude.
const bodyFace = makeAncestryQuery(['@u|u_0a3cb58fde38f980', '@ex1', '@body_ex1', '@sk1/left', '@cls_xn'], 'flatface')

// The sketches one extrude profile consumes.
const fromProfile = (profile: string, features: PartFeature[]) =>
  consumedSketchIds(ex('probe', [profile]), features)

describe('consumedSketchIds', () => {
  it('names the sketch behind an entity pick', () => {
    expect(fromProfile('entity:sk1:circle1', [sk('sk1')])).toEqual(['sk1'])
  })

  it('names the sketch behind an absolute ref', () => {
    expect(fromProfile('@sk1/circle1', [sk('sk1')])).toEqual(['sk1'])
  })

  it('ignores a profile that names no sketch', () => {
    const features = [sk('sk1'), ex('ex1', [])]
    expect(fromProfile('@ex1/face0', features)).toEqual([])
    expect(fromProfile('', features)).toEqual([])
  })

  it('does not count a body face as its sketch, although its ancestry names the sketch', () => {
    // Extruding off that face consumes the body, not the sketch behind it.
    expect(fromProfile(bodyFace, [sk('sk1'), ex('ex1', [])])).toEqual([])
  })

  it('collects profile and path sketches of a sweep, without duplicates', () => {
    const features: PartFeature[] = [sk('sk1'), sk('sk2'), {
      id: 'sw1', kind: 'sweep',
      sweep: { sketch: ['entity:sk1:circle1', '@sk1/circle2'], path: ['entity:sk2:line1'] },
    }]
    expect(consumedSketchIds(features[2], features).sort()).toEqual(['sk1', 'sk2'])
  })

  it('collects the hole sketch', () => {
    const features: PartFeature[] = [sk('sk1'), {
      id: 'h1', kind: 'hole',
      hole: { sketch: '@sk1/point1', diameter: 4, depth_mode: 'blind', depth: 5 },
    }]
    expect(consumedSketchIds(features[1], features)).toEqual(['sk1'])
  })

  it('yields nothing for a feature that consumes no sketch', () => {
    const features: PartFeature[] = [sk('sk1'), { id: 'f1', kind: 'fillet', fillet: { edges: [], radius: 1 } }]
    expect(consumedSketchIds(features[1], features)).toEqual([])
  })
})

describe('allConsumedSketchIds', () => {
  it('unions what every feature consumes', () => {
    const features = [sk('sk1'), sk('sk2'), sk('sk3'), ex('ex1', ['@sk1/c1']), ex('ex2', ['@sk2/c1', bodyFace])]
    expect([...allConsumedSketchIds(features)].sort()).toEqual(['sk1', 'sk2'])
  })
})
