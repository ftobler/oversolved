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
  COLOR_PREVIEW,
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

  it('selection outranks removal on the doomed face', () => {
    // Nominal only: the doomed face renders fully transparent, so this colour
    // never reaches the pixels. It is kept so the precedence stays "selection
    // claims the surface" -- the visible affordance for the re-click is the
    // wireframe brightening, pinned in Body3D.removedByEdit.test.tsx.
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
    // The mark now lives on the WIREFRAME, so the pink edges of a doomed body
    // sit next to the grey edges of the survivors. The nearest remaining
    // colour is the grey COLOR_PREVIEW at about 98 RGB units: COLOR_PREVIEW_EDGE
    // used to hold that spot but was dropped from this guard when the user made
    // the preview overlay share the mark hue exactly (both #bb5be1, distance 0
    // by design, so guarding against it would always fail).
    const { nearest, distance } = bodyRemovedColorIsDistinct()
    expect(nearest).toBe(COLOR_PREVIEW)
    expect(distance).toBeGreaterThanOrEqual(REMOVED_COLOR_MIN_DISTANCE)
  })

  it('is measured against COLOR_ERROR specifically', () => {
    // COLOR_ERROR is not the nearest neighbour any more (the grey preview is),
    // but the red-orange error paint is still the collision this mark is most
    // exposed to: it draws sketch entities in the SAME viewport whenever the
    // active sketch is overconstrained. Pinning its distance stops a future
    // hue tweak from drifting the pink toward it.
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

  it('makes a doomed body fully transparent, whatever the user styled', () => {
    // The old clamp band existed to keep the pink FACE mark visible; the mark
    // has moved to the wireframe, so the face can go all the way to invisible.
    for (const t of [0, 0.2, 1]) {
      expect(bodySurfaceLook({ removedByEdit: true, transparency: t }).transparency).toBe(1)
    }
  })

  it('a selected doomed body stays fully transparent', () => {
    // Selection recolours the surface but does not un-doom; the affordance for
    // the re-click is the brightened wireframe, not the face.
    expect(bodySurfaceLook({ selected: true, removedByEdit: true }).transparency).toBe(1)
  })
})
