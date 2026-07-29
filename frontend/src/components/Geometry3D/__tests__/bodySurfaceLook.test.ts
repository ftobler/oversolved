// The doomed-body look (feature: delete-preview-marking). A ghost the previewed
// edit consumes is drawn marked instead of hidden, so its colour now competes
// with two other claims on the same surface; this pins the order.
import { describe, it, expect } from 'vitest'
import {
  bodySurfaceLook,
  bodyRemovedColorIsDistinct,
  REMOVED_COLOR_MIN_DISTANCE,
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  COLOR_BODY_REMOVED,
  COLOR_ERROR,
  BODY_REMOVED_TRANSPARENCY,
  BODY_REMOVED_TRANSPARENCY_MAX,
  DEFAULT_PART_ROUGHNESS,
} from '@/components/Geometry3D/constants'

describe('bodySurfaceLook colour precedence', () => {
  it('falls back to the default body colour', () => {
    expect(bodySurfaceLook({}).color).toBe(COLOR_BODY_DEFAULT)
  })

  it('uses the part colour when nothing else claims the surface', () => {
    expect(bodySurfaceLook({ color: '#123456' }).color).toBe('#123456')
  })

  it('removal outranks the part colour', () => {
    expect(bodySurfaceLook({ removedByEdit: true, color: '#123456' }).color).toBe(COLOR_BODY_REMOVED)
  })

  it('selection outranks removal', () => {
    // Otherwise the "click again to un-pick" affordance is invisible: the body
    // would keep the removal colour while the user is pointing at it.
    expect(bodySurfaceLook({ selected: true, removedByEdit: true, color: '#123456' }).color)
      .toBe(COLOR_BODY_SELECTED)
  })

  it('every removal gets the SAME look, whatever the part was wearing', () => {
    // The claim is about pixels, so it has to cover the material too: a doomed
    // body still wearing transmission=1 (glass) or metalness=1 is a different
    // surface and the mark washes out.
    const looks = [
      { color: '#123456', transmission: 1, metalness: 1, roughness: 0.05 },
      { color: '#654321', transparency: 0.2 },
      {},
    ].map(style => JSON.stringify(bodySurfaceLook({ removedByEdit: true, ...style })))
    expect(new Set(looks).size).toBe(1)
  })

  it('leaves the material of a body the edit is not removing alone', () => {
    const style = { transmission: 1, metalness: 1, roughness: 0.05, transparency: 0.2 }
    expect(bodySurfaceLook(style)).toEqual({ color: COLOR_BODY_DEFAULT, ...style })
  })

  it('defaults roughness to DEFAULT_PART_ROUGHNESS, matching the old Body3D default', () => {
    expect(bodySurfaceLook({}).roughness).toBe(DEFAULT_PART_ROUGHNESS)
  })

  it('the removal colour is far from every other colour in the scene', () => {
    // A string !== check would pass for any two distinct hex values and would
    // have missed the collision that actually happened: the first pick,
    // '#e0554d', was 12 units from COLOR_ERROR, which paints sketch entities
    // in the SAME viewport whenever the active sketch is overconstrained.
    const { nearest, distance } = bodyRemovedColorIsDistinct()
    expect({ nearest, tooClose: distance < REMOVED_COLOR_MIN_DISTANCE })
      .toEqual({ nearest, tooClose: false })
  })

  it('is measured against COLOR_ERROR specifically', () => {
    // The nearest neighbour is the one worth naming: red-on-red is the
    // confusion this palette is most exposed to.
    const [r, g, b] = [...COLOR_ERROR.slice(1).match(/../g)!].map(h => parseInt(h, 16))
    const [r2, g2, b2] = [...COLOR_BODY_REMOVED.slice(1).match(/../g)!].map(h => parseInt(h, 16))
    expect(Math.hypot(r - r2, g - g2, b - b2)).toBeGreaterThanOrEqual(REMOVED_COLOR_MIN_DISTANCE)
  })
})

describe('bodySurfaceLook transparency', () => {
  it('passes the part transparency through untouched when nothing is removed', () => {
    expect(bodySurfaceLook({ transparency: 0.25 }).transparency).toBe(0.25)
    expect(bodySurfaceLook({}).transparency).toBe(0)
  })

  it('makes a doomed body see-through', () => {
    expect(bodySurfaceLook({ removedByEdit: true }).transparency).toBe(BODY_REMOVED_TRANSPARENCY)
  })

  it('never makes a doomed body MORE solid than the user styled it', () => {
    expect(bodySurfaceLook({ removedByEdit: true, transparency: 0.85 }).transparency).toBe(0.85)
  })

  it('a doomed body is never fully transparent, whatever the user styled', () => {
    // setClampedStyleField allows transparency 1. Without a ceiling the body
    // renders invisible while still sitting in the id buffer: an unmarked
    // click-blocker, strictly worse than the hide this feature replaced.
    for (const t of [0.95, 0.99, 1]) {
      expect(bodySurfaceLook({ removedByEdit: true, transparency: t }).transparency)
        .toBeLessThanOrEqual(BODY_REMOVED_TRANSPARENCY_MAX)
    }
    expect(bodySurfaceLook({ removedByEdit: true, transparency: 1 }).transparency).toBeLessThan(1)
  })

  it('the floor is below the ceiling, so the band is real', () => {
    expect(BODY_REMOVED_TRANSPARENCY).toBeLessThan(BODY_REMOVED_TRANSPARENCY_MAX)
    expect(BODY_REMOVED_TRANSPARENCY_MAX).toBeLessThan(1)
  })

  it('a selected doomed body keeps the removal transparency', () => {
    // Selection recolours; it does not un-doom.
    expect(bodySurfaceLook({ selected: true, removedByEdit: true }).transparency)
      .toBe(BODY_REMOVED_TRANSPARENCY)
  })
})
