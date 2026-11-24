// The one sketch-point site rule the hole and the instance pattern share:
// non-construction points in entity order, construction points skipped, line
// endpoints never targets, projected points counting. The hole's own tests are
// the real guard that the extraction changed no sentence for it; this file pins
// the rule and the instance pattern's adapted wording.

import { describe, it, expect } from 'vitest'
import { HOLE_SITE_WORDING, INSTANCE_SITE_WORDING } from '../shared/drillSite'
import { circleKindOf, pickedPointSite, sketchPointSites } from '../shared/sketchPointSites'

type Dict = Record<string, unknown>

const entities: Dict[] = [
  { id: 'ln', kind: 'line' },
  { id: 'pc', kind: 'point', construction: true },
  { id: 'p1', kind: 'point' },
  { id: 'ci', kind: 'circle' },
  { id: 'p2', kind: 'point', projected: true },
]

// A sketch row and the ordered feature list, so every refusal names the sketch
// and the entity the way the tree does.
const sketch: Dict = { id: 'sk', kind: 'sketch', label: 'Plate', entities }
const naming = { sketch, features: [sketch] }

describe('sketchPointSites', () => {
  it('returns the non-construction points in entity order', () => {
    expect(sketchPointSites(entities, 'sk').map((e) => e.id)).toEqual(['p1', 'p2'])
  })

  it('refuses a sketch with no points at all', () => {
    const lineOnly: Dict = { id: 'sk', kind: 'sketch', label: 'Plate', entities: [{ id: 'ln', kind: 'line' }] }
    const onlyNaming = { sketch: lineOnly, features: [lineOnly] }
    expect(() => sketchPointSites([{ id: 'ln', kind: 'line' }], 'sk', HOLE_SITE_WORDING, onlyNaming)).toThrow(
      "sketch 'Plate' has no point entities; the hole needs a point in its sketch to drill",
    )
    expect(() => sketchPointSites(
      [{ id: 'ln', kind: 'line' }], 'sk', INSTANCE_SITE_WORDING, onlyNaming,
    )).toThrow(
      "sketch 'Plate' has no point entities; the instance pattern needs a point in its sketch to copy the source onto",
    )
  })

  it('names the circle remedy when the sketch has no points but a circle', () => {
    const circleOnly: Dict = { id: 'sk', kind: 'sketch', label: 'Plate', entities: [{ id: 'ci', kind: 'circle' }] }
    const onlyNaming = { sketch: circleOnly, features: [circleOnly] }
    expect(() => sketchPointSites([{ id: 'ci', kind: 'circle' }], 'sk', HOLE_SITE_WORDING, onlyNaming)).toThrow(
      /has no point entities: a hole drills points at its `diameter`; put a point at the circle's centre/,
    )
    expect(() => sketchPointSites(
      [{ id: 'ci', kind: 'circle' }], 'sk', INSTANCE_SITE_WORDING, onlyNaming,
    )).toThrow(
      /has no point entities: an instance pattern copies the source onto points; put a point at the circle's centre/,
    )
  })

  it('refuses construction-only points with the flag remedy', () => {
    expect(() => sketchPointSites([{ id: 'pc', kind: 'point', construction: true }], 'sk')).toThrow(
      /has only construction points.*clear the point's construction flag to drill it/,
    )
    expect(() => sketchPointSites(
      [{ id: 'pc', kind: 'point', construction: true }], 'sk', INSTANCE_SITE_WORDING,
    )).toThrow(/has only construction points.*clear the point's construction flag to copy the source onto it/)
  })

  it('keeps the construction circle alternative in the construction-only sentence', () => {
    expect(() => sketchPointSites([
      { id: 'pc', kind: 'point', construction: true },
      { id: 'ci', kind: 'circle' },
    ], 'sk')).toThrow(/has no drillable non-construction point.*cut the circle with an extrude cut/)
    expect(() => sketchPointSites([
      { id: 'pc', kind: 'point', construction: true },
      { id: 'ci', kind: 'circle' },
    ], 'sk', INSTANCE_SITE_WORDING)).toThrow(/has no non-construction target point/)
  })

  it('classifies the circles a refusal can offer', () => {
    expect(circleKindOf([{ kind: 'line' }])).toBe('none')
    expect(circleKindOf([{ kind: 'circle' }])).toBe('real')
    expect(circleKindOf([{ kind: 'circle', construction: true }])).toBe('construction')
  })
})

describe('pickedPointSite', () => {
  it('narrows to the one picked point', () => {
    expect(pickedPointSite(entities, 'sk', 'p1').id).toBe('p1')
  })

  it('refuses a construction point with the instance noun', () => {
    expect(() => pickedPointSite(
      entities, 'sk', 'pc', INSTANCE_SITE_WORDING, naming,
    )).toThrow(
      "point 1 of sketch 'Plate' is construction geometry, which names no target; " +
      'construction geometry is reference only; toggle its construction off to copy the source onto it, or pick the sketch itself',
    )
  })

  it('refuses a circle with the picked circle remedy', () => {
    expect(() => pickedPointSite(
      entities, 'sk', 'ci', INSTANCE_SITE_WORDING, naming,
    )).toThrow(
      "circle 1 of sketch 'Plate' is not a target: an instance pattern copies the source onto points; " +
      "put a point at the circle's centre, or cut the circle with an extrude cut",
    )
  })

  it('refuses a line by name in both wordings', () => {
    expect(() => pickedPointSite(entities, 'sk', 'ln', HOLE_SITE_WORDING, naming)).toThrow(
      "line 1 of sketch 'Plate' is not a point, so it names no drill site; pick a sketch point, or the sketch itself",
    )
    expect(() => pickedPointSite(
      entities, 'sk', 'ln', INSTANCE_SITE_WORDING, naming,
    )).toThrow(
      "line 1 of sketch 'Plate' is not a point, so it names no target; pick a sketch point, or list the targets one by one",
    )
  })

  it('never prints the id it refused', () => {
    for (const eid of ['pc', 'ci', 'ln']) {
      let message = ''
      try {
        pickedPointSite(entities, 'sk', eid, HOLE_SITE_WORDING, naming)
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).not.toContain(`'${eid}'`)
      expect(message).not.toContain("'sk'")
    }
  })

  it('keeps the hole wording constant byte for byte', () => {
    expect(HOLE_SITE_WORDING.site).toBe('drill site')
    expect(HOLE_SITE_WORDING.feature).toBe('hole')
  })
})
