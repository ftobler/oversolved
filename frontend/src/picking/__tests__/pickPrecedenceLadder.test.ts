import { describe, it, expect } from 'vitest'
import {
  IdPipeline, DEFAULT_WINDOW_SIZE,
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
} from '../IdPipeline'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '../layerNames'
import { IdImage } from './pickCanvasHarness'

/**
 * The precedence contract: a point outranks a line outranks an area, whatever
 * the distances are, as long as the higher-ranked mark is inside the disc at
 * all. That is what makes a 1 px dot pickable next to a curve that floods the
 * window -- the dot is one pixel and the curve is dozens, so any distance-first
 * rule hands the curve every pick that is not dead-centre on the dot.
 *
 * The resolver is written that way (priority sorts before distance), and the
 * pieces are unit-tested. What was not tested is the ladder as a whole through
 * the real pipeline, with the loser actually FLOODING the region rather than
 * sitting at one convenient pixel -- which is the shape the bug takes in the
 * hand, and the shape a distance-first regression would show up in.
 */

const SIZE = 128
const RADIUS = (DEFAULT_WINDOW_SIZE - 1) / 2  // 8
const CURSOR = { x: 64.5, y: 64.5 }

// Ascending pick precedence, as IdPipeline mounts them.
const LADDER = [
  PLANE_LAYER_NAME,          // -10
  FACE_LAYER_NAME,           //   0
  EDGE_LAYER_NAME,           //  10
  VERTEX_LAYER_NAME,         //  20
  SKETCH_SURFACE_LAYER_NAME, //  30
  SKETCH_ENTITY_LAYER_NAME,  //  40
  ORIGIN_LAYER_NAME,         //  45
  SKETCH_VERTEX_LAYER_NAME,  //  50
  DIMENSION_LABEL_LAYER_NAME,//  70
  FEATURE_HANDLE_LAYER_NAME, //  80
  GIZMO_HANDLE_LAYER_NAME,   //  90
] as const

function fresh() {
  const image = new IdImage(SIZE, SIZE)
  const p = new IdPipeline({ width: SIZE, height: SIZE })
  p.target.markClean()
  return { image, p, renderer: image.renderer() }
}

describe('pick precedence: the mounted ladder', () => {
  it('orders the pipeline priorities exactly as the ladder claims', () => {
    const prio = new IdPipeline({ width: 8, height: 8 }).getLayerPriority()
    const mounted = Object.keys(prio).sort((a, b) => prio[a] - prio[b])
    expect(mounted).toEqual([...LADDER])
  })

  it('lets the higher layer win from anywhere in the disc against a lower one under the cursor', () => {
    // Every ordered pair, not just the adjacent ones: the loser is painted on
    // the cursor's own pixel (distance 0.71) and the winner is pushed out to the
    // far rim (distance ~7.8). Distance-first would flip every one of these.
    for (let lo = 0; lo < LADDER.length; lo++) {
      for (let hi = lo + 1; hi < LADDER.length; hi++) {
        const { image, p, renderer } = fresh()
        const loId = p.registry.allocate(LADDER[lo], `lo:${lo}`)
        const hiId = p.registry.allocate(LADDER[hi], `hi:${hi}`)
        image.mark(64, 64, loId)
        image.mark(64 + 7, 64 + 3, hiId)  // 7.7 px out, still inside
        const hit = p.resolveSync(renderer, CURSOR)
        expect({ lo: LADDER[lo], hi: LADDER[hi], won: hit?.layer }).toEqual(
          { lo: LADDER[lo], hi: LADDER[hi], won: LADDER[hi] },
        )
        p.dispose()
      }
    }
  })

  it('lets a single point beat a line and an area that flood the whole disc', () => {
    // The real geometry: a sketch curve marks a contiguous run of pixels
    // through the cursor and the surface under it marks every pixel, while the
    // point marks exactly one. The point still wins from every position inside
    // the disc.
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        if (Math.hypot(dx + 0.5 - 0.5, dy + 0.5 - 0.5) > RADIUS) continue
        const { image, p, renderer } = fresh()
        const surface = p.registry.allocate(SKETCH_SURFACE_LAYER_NAME, 'srf')
        const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
        const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
        image.disc(64.5, 64.5, 20, surface)
        image.line(44, 64, 84, 64, curve)
        image.mark(64 + dx, 64 + dy, point)
        const hit = p.resolveSync(renderer, CURSOR)
        expect({ dx, dy, won: hit?.entityKey }).toEqual({ dx, dy, won: 'pt' })
        p.dispose()
      }
    }
  })

  it('hands the pick back to the line the moment the point leaves the disc', () => {
    // The other side of the same rule: precedence must not extend the point's
    // reach past the radius. Swept across the boundary in sub-pixel steps.
    const { image, p, renderer } = fresh()
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    image.line(44, 64, 84, 64, curve)
    image.mark(64, 56, point)  // 8 px straight up from the cursor's pixel centre
    for (let k = 0; k <= 2; k += 0.1) {
      const cursor = { x: 64.5, y: 64.5 + k }
      const gap = Math.hypot(0, 56.5 - cursor.y)
      const hit = p.resolveSync(renderer, cursor)
      expect({ k, won: hit?.entityKey }).toEqual({ k, won: gap <= RADIUS ? 'pt' : 'curve' })
    }
    p.dispose()
  })

  it('falls to the area only when neither point nor line is in the disc', () => {
    const { image, p, renderer } = fresh()
    const surface = p.registry.allocate(SKETCH_SURFACE_LAYER_NAME, 'srf')
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    image.disc(64.5, 64.5, 30, surface)
    image.line(20, 40, 100, 40, curve)  // 24 px up: out of reach
    image.mark(20, 20, point)           // far away: out of reach
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('srf')
    // Bring the curve into reach and it takes over from the area...
    image.line(20, 60, 100, 60, curve)
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('curve')
    // ...and the point takes over from the curve.
    image.mark(70, 68, point)
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('pt')
    p.dispose()
  })

  it('ranks b-rep vertex over edge over face at one shared pixel and across the disc', () => {
    const { image, p, renderer } = fresh()
    const face = p.registry.allocate(FACE_LAYER_NAME, 'f')
    const edge = p.registry.allocate(EDGE_LAYER_NAME, 'e')
    const vtx = p.registry.allocate(VERTEX_LAYER_NAME, 'v')
    image.disc(64.5, 64.5, 30, face)
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('f')
    image.line(40, 70, 90, 70, edge)  // 5.5 px below
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('e')
    image.mark(60, 68, vtx)  // 5.7 px away, one pixel
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('v')
    p.dispose()
  })

  it('orders the full candidate list by priority first and distance second', () => {
    // `resolveAllSync` is what the mate pick chip cycles through, and its first
    // element is defined to be the single hit. Both halves asserted at once.
    const { image, p, renderer } = fresh()
    const face = p.registry.allocate(FACE_LAYER_NAME, 'f')
    const nearEdge = p.registry.allocate(EDGE_LAYER_NAME, 'e-near')
    const farEdge = p.registry.allocate(EDGE_LAYER_NAME, 'e-far')
    const vtx = p.registry.allocate(VERTEX_LAYER_NAME, 'v')
    image.disc(64.5, 64.5, 30, face)
    image.mark(64, 63, nearEdge)
    image.mark(64, 59, farEdge)
    image.mark(64, 58, vtx)
    const all = p.resolveAllSync(renderer, CURSOR)
    expect(all.map(h => h.entityKey)).toEqual(['v', 'e-near', 'e-far', 'f'])
    expect(all[0]).toEqual(p.resolveSync(renderer, CURSOR))
    p.dispose()
  })

  it('keeps precedence when the allowed-layer filter removes the winner', () => {
    // The per-tool filter runs inside the scan, so a filtered-out layer must
    // not merely lose -- it must be absent, leaving the next rung to answer.
    const { image, p, renderer } = fresh()
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
    const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'pt')
    image.line(44, 64, 84, 64, curve)
    image.mark(68, 62, point)
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('pt')
    expect(p.resolveSync(renderer, CURSOR, {
      allowedLayers: new Set([SKETCH_ENTITY_LAYER_NAME]),
    })!.entityKey).toBe('curve')
    p.dispose()
  })

  it('breaks a same-layer tie toward the nearer mark, at every ratio', () => {
    for (const pixelRatio of [1, 2, 3]) {
      const image = new IdImage(SIZE, SIZE)
      const p = new IdPipeline({ width: SIZE, height: SIZE, pixelRatio })
      p.target.markClean()
      const a = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'a')
      const b = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'b')
      image.mark(64 + 2, 64, a)
      image.mark(64 + 4, 64, b)
      expect(p.resolveSync(image.renderer(), CURSOR)!.entityKey).toBe('a')
      image.mark(64 - 1, 64, b)
      expect(p.resolveSync(image.renderer(), CURSOR)!.entityKey).toBe('b')
      p.dispose()
    }
  })
})
