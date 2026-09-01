import { describe, it, expect } from 'vitest'
import {
  IdPipeline, DEFAULT_WINDOW_SIZE,
  SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  DIMENSION_LABEL_LAYER_NAME,
} from '../IdPipeline'
import { IdImage } from './pickCanvasHarness'

/**
 * The catch geometry the design produces: elements mark the fewest pixels that
 * keep them continuous on the grid, and the snap comes from the scan disc
 * around the cursor rather than from drawing anything fatter.
 *
 * Two consequences follow from that and neither was pinned. First, the reach is
 * one number shared by every layer, so nothing distinguishes a point from a
 * curve in how FAR it catches -- only in how many pixels it offers to be caught
 * by. Second, a mark that is one pixel is all-or-nothing: anything drawn later
 * at that pixel does not shrink it, it erases it, and an erased mark cannot
 * lose a priority sort because it was never in the map.
 *
 * These are characterisations, not complaints. They are here so the numbers are
 * checkable and so the erasure case has a name.
 */

const SIZE = 160
const RADIUS = (DEFAULT_WINDOW_SIZE - 1) / 2  // 8
const MID = 80

function scene() {
  const image = new IdImage(SIZE, SIZE)
  const p = new IdPipeline({ width: SIZE, height: SIZE })
  p.target.markClean()
  return { image, p, renderer: image.renderer() }
}

/** Cursor positions on a 1 px lattice around the mark from which `key` answers. */
function catchArea(
  p: IdPipeline, renderer: ReturnType<IdImage['renderer']>, key: string, span = 30,
): number {
  let n = 0
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (p.resolveSync(renderer, { x: MID + 0.5 + dx, y: MID + 0.5 + dy })?.entityKey === key) n++
    }
  }
  return n
}

describe('catch geometry: one pixel marked, eight pixels of reach', () => {
  it('gives a one-pixel mark the full disc and nothing more', () => {
    const { image, p, renderer } = scene()
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    image.mark(MID, MID, id)
    const area = catchArea(p, renderer, 'pt')
    expect(area).toBeGreaterThan(Math.PI * RADIUS * RADIUS - 12)
    expect(area).toBeLessThan(Math.PI * RADIUS * RADIUS + 12)
    p.dispose()
  })

  it('reaches the same 8 px whatever the layer is', () => {
    // There is no per-layer radius: a point, a curve pixel and a label anchor
    // all catch from exactly the same distance. Worth pinning because the only
    // way to make one reach further is to give it more pixels, and that is a
    // decision about what a layer draws, not about the window.
    const reaches = [
      SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
      ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
    ].map(layer => {
      const { image, p, renderer } = scene()
      const id = p.registry.allocate(layer, `k:${layer}`)
      image.mark(MID, MID, id)
      let best = 0
      for (let k = 0; k <= 24; k += 0.05) {
        if (!p.resolveSync(renderer, { x: MID + 0.5 + k, y: MID + 0.5 })) break
        best = k
      }
      p.dispose()
      return Math.round(best * 20) / 20
    })
    expect(new Set(reaches).size).toBe(1)
    expect(reaches[0]).toBeCloseTo(RADIUS, 1)
  })

  it('hands a point on a curve the pick within 8 px of the dot and not beyond', () => {
    // The contract working as specified: the point outranks the curve wherever
    // the point is reachable, and past that the point simply has no pixel to be
    // caught by, so the curve answers. The curve is one pixel wide throughout;
    // what differs is that it offers a pixel at every step along its length.
    const { image, p, renderer } = scene()
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    image.line(MID - 60, MID, MID + 60, MID, curve)
    image.mark(MID, MID, point)
    expect(catchArea(p, renderer, 'pt')).toBeGreaterThan(Math.PI * RADIUS * RADIUS - 12)
    expect(p.resolveSync(renderer, { x: MID + 8.4, y: MID + 0.5 })!.entityKey).toBe('pt')
    expect(p.resolveSync(renderer, { x: MID + 9.0, y: MID + 0.5 })!.entityKey).toBe('curve')
    p.dispose()
  })

  it('loses a one-pixel mark entirely when a later layer writes that pixel', () => {
    // The failure mode a one-pixel mark has and a run of pixels does not. The
    // origin draws after the sketch vertex, so a vertex constrained onto the
    // document origin has its ONLY pixel overwritten: it is not outranked, it
    // is absent, and no priority rule can recover it.
    const { image, p, renderer } = scene()
    const vtx = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:E1:start')
    const origin = p.registry.allocate(ORIGIN_LAYER_NAME, '@builtin_origin')
    image.mark(MID, MID, vtx)
    expect(p.resolveAllSync(renderer, { x: MID + 0.5, y: MID + 0.5 }).map(h => h.entityKey))
      .toEqual(['vertex:S1:E1:start'])
    image.mark(MID, MID, origin)  // the ID pass draws originMarker after sketchVertex
    expect(p.resolveAllSync(renderer, { x: MID + 0.5, y: MID + 0.5 }).map(h => h.entityKey))
      .toEqual(['@builtin_origin'])
    p.dispose()
  })

  it('drops the covered point out of the candidate list, not just off the top of it', () => {
    // The distinction that matters for the pick chip and for any "cycle through
    // what is here" affordance: an overwritten one-pixel mark cannot be cycled
    // to, because resolveAllSync never sees it. A curve under the same cover
    // survives on its other pixels.
    const { image, p, renderer } = scene()
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    const label = p.registry.allocate(DIMENSION_LABEL_LAYER_NAME, 'dim:c1')
    image.line(MID - 60, MID, MID + 60, MID, curve)
    image.mark(MID, MID, point)
    image.mark(MID, MID, label)  // dimensionLabel draws after sketchVertex
    const keys = p.resolveAllSync(renderer, { x: MID + 0.5, y: MID + 0.5 }).map(h => h.entityKey)
    expect(keys).toEqual(['dim:c1', 'curve'])
    expect(keys).not.toContain('pt')
    p.dispose()
  })

  it('lets the curve answer once the cover is erased AND filtered out by the tool', () => {
    // The full shape of "the line wins where the point should". Erasure alone
    // hands the pick to the coverer, which is visible and explicable. But a
    // drawing tool's allowedLayers admits plane / sketchEntity / sketchVertex /
    // originMarker and NOT dimensionLabel, so a label anchor sitting on a
    // vertex pixel removes the vertex from the buffer and then removes itself
    // from the answer -- and the curve underneath, which was never covered
    // anywhere else along its length, is what is left.
    const { image, p, renderer } = scene()
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    const label = p.registry.allocate(DIMENSION_LABEL_LAYER_NAME, 'dim:c1')
    image.line(MID - 60, MID, MID + 60, MID, curve)
    image.mark(MID, MID, point)
    const drawToolLayers = new Set([SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME])
    const cursor = { x: MID + 0.5, y: MID + 0.5 }
    expect(p.resolveSync(renderer, cursor, { allowedLayers: drawToolLayers })!.entityKey).toBe('pt')
    image.mark(MID, MID, label)
    expect(p.resolveSync(renderer, cursor, { allowedLayers: drawToolLayers })!.entityKey).toBe('curve')
    p.dispose()
  })
})
