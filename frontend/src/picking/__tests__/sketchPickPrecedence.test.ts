import { describe, it, expect } from 'vitest'
import {
  IdPipeline, DEFAULT_WINDOW_SIZE,
  SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
} from '../IdPipeline'
import { IdImage } from './pickCanvasHarness'

/**
 * What the sketch half of the ladder costs a point pick.
 *
 * The dimensional order inside the sketch group is right -- surface below curve
 * below point -- and a point wins from anywhere in the disc, which the ladder
 * test covers. What it does not say is that TWO layers sit ABOVE the sketch
 * point and both of them mark a single pixel each: the origin marker at 60 and
 * the dimension label at 70. Neither is a region the user aims at; each is one
 * pixel with an 8 px reach, and inside that reach a real sketch point cannot be
 * picked at all.
 *
 * And below them, one layer carries two populations: the real vertices and the
 * inferred `dock:` / `isect:` handles both live in sketchVertex at 50. Between
 * those, priority has nothing to say, so they are separated only by distance --
 * and, when they land on one pixel, by which was written last.
 *
 * `INFERRED_TOL` (snapDetection) dedups the inferred set against itself at
 * 1e-3 SKETCH UNITS. That is a world-space guard on a pixel-space collision:
 * how many millimetres fall in one pixel is a function of zoom, so two marks
 * that are distinct at one zoom share a pixel at another.
 */

const SIZE = 160
const RADIUS = (DEFAULT_WINDOW_SIZE - 1) / 2  // 8
const MID = 80
const CURSOR = { x: MID + 0.5, y: MID + 0.5 }

function scene() {
  const image = new IdImage(SIZE, SIZE)
  const p = new IdPipeline({ width: SIZE, height: SIZE })
  p.target.markClean()
  return { image, p, renderer: image.renderer() }
}

describe('sketch precedence: what outranks a sketch point', () => {
  it('takes the sketch point\'s catch region away wherever the origin can also be seen', () => {
    // The origin is where the first constraint in every sketch goes, so a circle
    // centre or a line end sits on or beside it constantly. What the point keeps
    // is only the lune its own disc has outside the origin's -- and nothing at
    // all once the two share a pixel. Measured rather than asserted, because the
    // interesting number is how fast it collapses with distance.
    const survives = (gapPx: number): number => {
      const { image, p, renderer } = scene()
      const pt = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:C1:center')
      const origin = p.registry.allocate(ORIGIN_LAYER_NAME, '@builtin_origin')
      image.mark(MID, MID, pt)
      image.mark(MID + gapPx, MID, origin)
      let n = 0
      for (let dy = -RADIUS - 1; dy <= RADIUS + 1; dy++) {
        for (let dx = -RADIUS - 1; dx <= RADIUS + 1; dx++) {
          if (p.resolveSync(renderer, { x: MID + 0.5 + dx, y: MID + 0.5 + dy })?.entityKey
              === 'vertex:S1:C1:center') n++
        }
      }
      p.dispose()
      return n
    }
    // How many of the 197 lattice positions in the point's own disc still
    // answer with the point, as the origin marker moves away from it.
    expect([0, 1, 2, 3, 4, 6, 8, 12, 16, 40].map(survives))
      .toEqual([0, 17, 32, 47, 62, 92, 120, 170, 196, 197])
  })

  it('does the same for a dimension label anchor, which is also one pixel', () => {
    const { image, p, renderer } = scene()
    const pt = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:start')
    const label = p.registry.allocate(DIMENSION_LABEL_LAYER_NAME, 'dim:c_length_1')
    image.mark(MID, MID, pt)
    image.mark(MID + 5, MID - 2, label)
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('dim:c_length_1')
    // Only once the label's own pixel is out of reach does the point answer.
    expect(p.resolveSync(renderer, { x: MID - 6.5, y: MID + 0.5 })!.entityKey)
      .toBe('vertex:S1:L1:start')
    p.dispose()
  })

  it('keeps the point above the curve and the area, which is the half that works', () => {
    const { image, p, renderer } = scene()
    const area = p.registry.allocate(SKETCH_SURFACE_LAYER_NAME, 'area:S1:0')
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'entity:S1:C1')
    const pt = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:C1:center')
    image.disc(MID + 0.5, MID + 0.5, 40, area)
    image.line(MID - 40, MID, MID + 40, MID, curve)
    image.mark(MID + 7, MID + 3, pt)  // 7.6 px out, the far rim
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('vertex:S1:C1:center')
    p.dispose()
  })
})

describe('sketch precedence: inside the vertex layer, priority has nothing to say', () => {
  it('separates an inferred handle from a real point by distance alone', () => {
    // Both are sketchVertex at 50, so the nearer pixel wins and the two swap as
    // the cursor moves. Neither can outrank the other however the user thinks
    // about them.
    const { image, p, renderer } = scene()
    const real = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:end')
    const isect = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'isect:S1:3.0:4.0:C1:L1')
    image.mark(MID - 2, MID, real)
    image.mark(MID + 3, MID, isect)
    expect(p.resolveSync(renderer, { x: MID - 1.5, y: MID + 0.5 })!.entityKey).toBe('vertex:S1:L1:end')
    expect(p.resolveSync(renderer, { x: MID + 2.5, y: MID + 0.5 })!.entityKey).toBe('isect:S1:3.0:4.0:C1:L1')
    p.dispose()
  })

  it('erases the real point when an inferred handle lands on its pixel', () => {
    // `useSketchIdRegistration` appends the inferred contacts AFTER the real
    // vertices into one THREE.Points, so on a shared pixel the handle is what
    // survives -- always in that direction, never the other. The real point is
    // then absent from the buffer, so it is not last in the candidate list, it
    // is not in it. The dedup that exists (INFERRED_TOL, 1e-3 sketch units)
    // cannot see this: whether two marks share a pixel depends on zoom.
    const { image, p, renderer } = scene()
    const real = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:end')
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'entity:S1:C1')
    const dock = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'dock:S1:C1:L1')
    image.line(MID - 40, MID, MID + 40, MID, curve)
    image.mark(MID, MID, real)
    expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
      .toEqual(['vertex:S1:L1:end', 'entity:S1:C1'])
    image.mark(MID, MID, dock)  // same pixel, written later
    const keys = p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey)
    expect(keys).toEqual(['dock:S1:C1:L1', 'entity:S1:C1'])
    expect(keys).not.toContain('vertex:S1:L1:end')
    p.dispose()
  })

  it('erases one real point with another when two share a pixel', () => {
    // The same thing without any inferred set involved: a line end drawn onto a
    // circle with no coincident constraint yet. `suppressedCoincidentVertexIds`
    // only hides CONSTRAINT-backed partners, so an unconstrained overlap is two
    // live registrations competing for one pixel.
    const { image, p, renderer } = scene()
    const a = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:end')
    const b = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:C1:center')
    image.mark(MID, MID, a)
    image.mark(MID, MID, b)
    expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
      .toEqual(['vertex:S1:C1:center'])
    p.dispose()
  })
})
