import { describe, it, expect } from 'vitest'
import {
  IdPipeline, DEFAULT_WINDOW_SIZE,
  SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
} from '../IdPipeline'
import { IdImage } from './pickCanvasHarness'

/**
 * What the sketch half of the ladder does to a point pick.
 *
 * The dimensional order inside the sketch group is right -- surface below curve
 * below point -- and a point wins from anywhere in the disc, which the ladder
 * test covers. What it did not say was that two layers sat ABOVE the sketch
 * point marking a single pixel each, so that inside their 8 px reach a real
 * sketch point could not be picked at all. The origin marker was one of them
 * and has moved below the sketch vertex; the dimension label is still there,
 * pinned here because it is the same shape of problem and a different decision.
 *
 * Below them, one layer carries two populations: the real vertices and the
 * inferred `dock:` / `isect:` handles both live in sketchVertex at 50. Between
 * those, priority has nothing to say, so they are separated only by distance.
 * A shared pixel used to be an ERASURE with a fixed direction, because the
 * inferred handles are appended last; it is now a co-location the registry
 * knows about, so both come back and the real point leads.
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
  it('costs the point nothing to have the origin marker beside it', () => {
    // The origin is where the first constraint in every sketch goes, so a
    // circle centre or a line end sits on or beside it constantly. While the
    // marker outranked the point, the point kept only the lune its own disc had
    // outside the marker's -- 17 of its 197 lattice positions at one pixel
    // apart, 47 at three, none at zero. Below it, the point keeps all of them.
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
    expect([1, 2, 3, 4, 6, 8, 12, 16, 40].map(survives))
      .toEqual([197, 197, 197, 197, 197, 197, 197, 197, 197])
    // Zero is the one gap this cannot answer, because the marker overwrote the
    // point's only pixel and these ids carry no registered position. Through
    // the real layers it does answer -- see `coincidentMarkRecovery`.
    expect(survives(0)).toBe(0)
  })

  it('still loses the point to a dimension label anchor, which is also one pixel', () => {
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

  it('no longer loses the real point to an inferred handle on its pixel', () => {
    // `useSketchIdRegistration` appends the inferred contacts AFTER the real
    // vertices into one THREE.Points, so the handle used to be drawn last and
    // the real point left the buffer entirely -- always in that direction,
    // never the other. The dedup that exists could not see it: `INFERRED_TOL`
    // is 1e-3 SKETCH UNITS, and how many units fall in one pixel is a function
    // of zoom. Now both are registered at one position, so the pixel is one
    // mark that answers for both, and the real point leads because it was
    // registered first.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1',
      vertices: [[2, 3, 0], [2, 3, 0]],
      vertexQueries: ['vertex:S1:L1:end', 'dock:S1:C1:L1'],
    })
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'entity:S1:C1')
    image.line(MID - 40, MID, MID + 40, MID, curve)
    image.mark(MID, MID, p.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'dock:S1:C1:L1')!)
    expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
      .toEqual(['vertex:S1:L1:end', 'dock:S1:C1:L1', 'entity:S1:C1'])
    p.dispose()
  })

  it('no longer loses one real point to another sharing its pixel', () => {
    // The same thing with no inferred set involved: a line end drawn onto a
    // circle before the coincident constraint exists.
    // `suppressedCoincidentVertexIds` merges only CONSTRAINT-backed partners --
    // and deliberately so, since dropping the constraint must bring both handles
    // back -- so an unconstrained overlap is two live registrations at one spot.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1',
      vertices: [[5, 5, 0], [5, 5, 0]],
      vertexQueries: ['vertex:S1:L1:end', 'vertex:S1:C1:center'],
    })
    image.mark(MID, MID, p.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:C1:center')!)
    expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
      .toEqual(['vertex:S1:L1:end', 'vertex:S1:C1:center'])
    p.dispose()
  })
})
