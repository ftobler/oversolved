import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { consumedSketchIds, sketchIdsInQuery } from '@/utils/query/consumedSketches'

const sk = (id: string): PartFeature => ({ id, kind: 'sketch' })

describe('sketchIdsInQuery', () => {
  it('names the sketch behind an entity pick', () => {
    expect(sketchIdsInQuery('entity:sk1:circle1', [sk('sk1')])).toEqual(['sk1'])
  })

  it('names the sketch behind an absolute ref', () => {
    expect(sketchIdsInQuery('@sk1/circle1', [sk('sk1')])).toEqual(['sk1'])
  })

  it('ignores a query that names no sketch', () => {
    const features: PartFeature[] = [sk('sk1'), { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } }]
    expect(sketchIdsInQuery('@ex1/face0', features)).toEqual([])
    expect(sketchIdsInQuery('', features)).toEqual([])
  })
})

describe('consumedSketchIds', () => {
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
