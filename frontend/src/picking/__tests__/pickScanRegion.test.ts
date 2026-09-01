import { describe, it, expect } from 'vitest'
import { IdPipeline, DEFAULT_WINDOW_SIZE, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import { IdImage } from './pickCanvasHarness'

/**
 * WHICH pixels the resolve scans, asserted against the closed-form region it is
 * supposed to be: the disc of radius 8 CSS px around the cursor's true
 * position, measured to each pixel's CENTRE.
 *
 * Every earlier test of this either hands the resolver a pre-cut window (so the
 * cut itself is assumed) or samples a handful of directions. Neither can see a
 * region that is the right SIZE but sits beside the cursor -- a half-pixel lean,
 * an off-by-one in the window's corner, a y-flip that mirrors the region about
 * the cursor row. Those all survive a symmetric spot check and all feel, in the
 * hand, like "the thing under the cursor is not the thing that answers".
 *
 * So these sweep the mark over the whole neighbourhood and compare catch to the
 * predicate, pixel by pixel, through the real `readWindow` path.
 */

const SIZE = 128
const RADIUS_CSS = (DEFAULT_WINDOW_SIZE - 1) / 2  // 8

function pipelineFor(image: IdImage, pixelRatio = 1) {
  const p = new IdPipeline({ width: image.width, height: image.height, pixelRatio })
  p.target.markClean()
  return p
}

/** The region the resolve is specified to cover, in device pixels. */
function shouldCatch(markX: number, markY: number, cursor: { x: number; y: number }, radius: number): boolean {
  return Math.hypot(markX + 0.5 - cursor.x, markY + 0.5 - cursor.y) <= radius
}

describe('pick scan region: the disc is around the cursor, not beside it', () => {
  // Cursor placements that put every rounding seam in play: dead centre of a
  // pixel, both edges of it, and either side of the boundary between two.
  const CURSORS = [
    { x: 64.5, y: 64.5 },
    { x: 64.0, y: 64.0 },
    { x: 64.999, y: 64.999 },
    { x: 64.1, y: 64.9 },
    { x: 64.9, y: 64.1 },
    { x: 63.5, y: 65.5 },
  ]

  it('catches exactly the pixels whose centres are within 8 px of the cursor', () => {
    // The whole claim, swept: 25x25 mark placements per cursor, each asserted
    // against the predicate rather than against a direction sample.
    for (const cursor of CURSORS) {
      const misses: string[] = []
      for (let my = 52; my <= 76; my++) {
        for (let mx = 52; mx <= 76; mx++) {
          const image = new IdImage(SIZE, SIZE)
          const p = pipelineFor(image)
          const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
          image.mark(mx, my, id)
          const caught = p.resolveSync(image.renderer(), cursor) !== null
          const want = shouldCatch(mx, my, cursor, RADIUS_CSS)
          if (caught !== want) misses.push(`(${mx},${my}) caught=${caught} want=${want}`)
          p.dispose()
        }
      }
      expect({ cursor, misses }).toEqual({ cursor, misses: [] })
    }
  })

  it('reports the true geometric distance to the mark it caught', () => {
    // The distance is what orders candidates within a layer, so a region that
    // is centred correctly but measures from the wrong origin still picks the
    // wrong one of two neighbours. Asserted for marks on all four sides.
    const cursor = { x: 40.25, y: 71.75 }
    for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [3, -4], [-3, 4]] as const) {
      const mx = Math.floor(cursor.x) + dx
      const my = Math.floor(cursor.y) + dy
      const image = new IdImage(SIZE, SIZE)
      const p = pipelineFor(image)
      const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
      image.mark(mx, my, id)
      const hit = p.resolveSync(image.renderer(), cursor)
      expect(hit).not.toBeNull()
      expect(hit!.distancePx).toBeCloseTo(Math.hypot(mx + 0.5 - cursor.x, my + 0.5 - cursor.y), 10)
      p.dispose()
    }
  })

  it('does not mirror the region about the cursor row (the y-flip)', () => {
    // A stitch that flips the wrong way still produces a disc of the right
    // size around the right column, so every symmetric test passes. It shows
    // up only when the two sides carry DIFFERENT marks: hover the upper one
    // and the lower one answers.
    const cursor = { x: 64.5, y: 64.5 }
    const image = new IdImage(SIZE, SIZE)
    const p = pipelineFor(image)
    const above = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'above')
    const below = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'below')
    image.mark(64, 62, above)   // 2 px up the screen
    image.mark(64, 70, below)   // 5 px down the screen
    expect(p.resolveSync(image.renderer(), cursor)!.entityKey).toBe('above')
    // ...and moving the cursor down past the midpoint hands over to the other.
    expect(p.resolveSync(image.renderer(), { x: 64.5, y: 67.0 })!.entityKey).toBe('below')
    p.dispose()
  })

  it('does not mirror or shift the region about the cursor column (the x axis)', () => {
    const image = new IdImage(SIZE, SIZE)
    const p = pipelineFor(image)
    const left = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'left')
    const right = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'right')
    image.mark(62, 64, left)
    image.mark(70, 64, right)
    expect(p.resolveSync(image.renderer(), { x: 64.5, y: 64.5 })!.entityKey).toBe('left')
    expect(p.resolveSync(image.renderer(), { x: 67.0, y: 64.5 })!.entityKey).toBe('right')
    p.dispose()
  })

  it('reaches the same distance along every angle, not just the compass points', () => {
    // The corner-discard is what makes this true; a square window reaches 41%
    // further at 45 degrees. Swept at 5-degree steps so an anisotropy that
    // happens to be symmetric under the eight compass directions is still seen.
    const image = new IdImage(SIZE, SIZE)
    const p = pipelineFor(image)
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
    image.mark(64, 64, id)
    const markCentre = { x: 64.5, y: 64.5 }
    const renderer = image.renderer()
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180
      let reach = 0
      for (let k = 0; k <= 12; k += 0.05) {
        const hit = p.resolveSync(renderer, {
          x: markCentre.x + Math.cos(rad) * k,
          y: markCentre.y + Math.sin(rad) * k,
        })
        if (!hit) break
        reach = k
      }
      expect({ deg, ok: reach > RADIUS_CSS - 0.1 && reach <= RADIUS_CSS }).toEqual({ deg, ok: true })
    }
    p.dispose()
  })

  it('keeps the region centred when the cursor is against a canvas edge', () => {
    // The read is bound-clipped and the remainder stitched at an offset. If the
    // offset is wrong the surviving pixels land in the wrong window slots, which
    // moves the region -- and only near an edge, which is why it can hide.
    const SMALL = 24
    const corners = [
      { x: 0.5, y: 0.5 }, { x: SMALL - 0.5, y: 0.5 },
      { x: 0.5, y: SMALL - 0.5 }, { x: SMALL - 0.5, y: SMALL - 0.5 },
      { x: 3.5, y: 0.5 }, { x: 0.5, y: 3.5 },
    ]
    for (const cursor of corners) {
      const misses: string[] = []
      for (let my = 0; my < SMALL; my++) {
        for (let mx = 0; mx < SMALL; mx++) {
          const image = new IdImage(SMALL, SMALL)
          const p = pipelineFor(image)
          const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
          image.mark(mx, my, id)
          const caught = p.resolveSync(image.renderer(), cursor) !== null
          const want = shouldCatch(mx, my, cursor, RADIUS_CSS)
          if (caught !== want) misses.push(`(${mx},${my}) caught=${caught} want=${want}`)
          p.dispose()
        }
      }
      expect({ cursor, misses }).toEqual({ cursor, misses: [] })
    }
  })

  it('answers nothing for a cursor outside the canvas', () => {
    const image = new IdImage(SIZE, SIZE)
    const p = pipelineFor(image)
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
    image.mark(0, 0, id)
    const renderer = image.renderer()
    for (const cursor of [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: SIZE, y: 0 }, { x: 0, y: SIZE }]) {
      expect(p.resolveSync(renderer, cursor)).toBeNull()
    }
    p.dispose()
  })
})

describe('pick scan region: the reach is 8 CSS px at every device pixel ratio', () => {
  // The catch region has to be a constant on-screen distance. Expressed in the
  // device pixels the buffer is actually read in, that is 8 * ratio -- rounded,
  // because the window edge has to stay odd for the cursor to own a centre pixel.
  for (const ratio of [1, 1.5, 2, 3]) {
    it(`holds the disc at radius round(8 * ${ratio}) device px`, () => {
      const radius = Math.round(RADIUS_CSS * ratio)
      const misses: string[] = []
      for (let my = 64 - radius - 2; my <= 64 + radius + 2; my++) {
        for (let mx = 64 - radius - 2; mx <= 64 + radius + 2; mx++) {
          const image = new IdImage(SIZE, SIZE)
          const p = pipelineFor(image, ratio)
          const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
          image.mark(mx, my, id)
          const caught = p.resolveSync(image.renderer(), { x: 64.5, y: 64.5 }) !== null
          const want = shouldCatch(mx, my, { x: 64.5, y: 64.5 }, radius)
          if (caught !== want) misses.push(`(${mx},${my}) caught=${caught} want=${want}`)
          p.dispose()
        }
      }
      expect({ ratio, misses }).toEqual({ ratio, misses: [] })
    })
  }

  it('never reaches less far in device pixels than the unscaled window did', () => {
    // The floor: a browser zoomed below 100% reports a ratio under 1, and
    // honouring it would read fewer device pixels than the flat 17 this window
    // was before it scaled at all.
    for (const ratio of [0.5, 0.75, 0.9, 1]) {
      const p = new IdPipeline({ width: SIZE, height: SIZE, pixelRatio: ratio })
      expect(p.getEffectiveWindowSize()).toBe(DEFAULT_WINDOW_SIZE)
      p.dispose()
    }
  })
})
