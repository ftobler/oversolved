import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import { idToRGB } from '../idEncoding'

/**
 * The reach must be the same on both sides of a mark, measured in the
 * continuous coordinates the user actually moves the cursor through.
 *
 * A pixel is an area and a cursor is a point, and the pick path quantises both:
 * GL rasterises a 1 px point into the pixel its projection falls in (centre
 * `floor(v) + 0.5`, up to half a pixel off the dot drawn at `v`), and the
 * resolver used to measure whole-pixel offsets from `Math.round(cursor)`.
 * Neither fraction cancels the other, and the leftover landed entirely on one
 * side: the reach ran up to 2 px further toward -x and -y -- left and up on
 * screen -- than the other way.
 *
 * The earlier region tests could not see this. They placed the mark at an
 * integer index and stepped the cursor over integers, so both fractions were
 * zero by construction and the bias was invisible. This one sweeps the cursor
 * in sub-pixel steps and puts the mark at every offset within its pixel.
 */

const SIZE = 128

// Serve one lit pixel at device index (markX, markY) in canvas coordinates.
function rendererWithMark(markX: number, markY: number, id: number) {
  const image = new Uint8Array(SIZE * SIZE * 4)
  const [r, g, b] = idToRGB(id)
  const i = ((SIZE - markY - 1) * SIZE + markX) * 4
  image[i] = r; image[i + 1] = g; image[i + 2] = b; image[i + 3] = 255
  return {
    readRenderTargetPixels: (_t: unknown, x: number, y: number, w: number, h: number, out: Uint8Array) => {
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * SIZE + x) * 4
        out.set(image.subarray(src, src + w * 4), row * w * 4)
      }
    },
  } as unknown as THREE.WebGLRenderer
}

/** How far the cursor can stray from `dot` along (sx, sy) and still hit. */
function reach(
  p: IdPipeline, renderer: THREE.WebGLRenderer,
  dot: { x: number; y: number }, sx: number, sy: number,
): number {
  let best = 0
  for (let k = 0; k <= 24; k += 0.05) {
    const hit = p.resolveSync(renderer, { x: dot.x + sx * k, y: dot.y + sy * k })
    if (!hit) break
    best = k
  }
  return best
}

describe('pick reach symmetry', () => {
  // Every sub-pixel placement a dot can land on within its pixel. The mark is
  // the pixel it falls in; the dot itself is drawn at the true position.
  const FRACTIONS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]
  const STEP = 0.05  // sweep resolution, so any reach can undershoot by this

  function pipelineWithDot(dot: { x: number; y: number }) {
    const p = new IdPipeline({ width: SIZE, height: SIZE })
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:P1:xy')
    const renderer = rendererWithMark(Math.floor(dot.x), Math.floor(dot.y), id)
    p.target.markClean()
    return { p, renderer }
  }

  it('reaches the radius equally in all four directions from the mark it can see', () => {
    // The resolver's own guarantee, and the one that was broken: measured from
    // the centre of the lit pixel, the reach must be the radius on every side,
    // for every sub-pixel placement of the dot that produced it. Before the
    // fix this read 9 px one way and 8 the other, because the window was
    // centred on `Math.round(cursor)` -- a pixel BOUNDARY -- and distances were
    // whole-pixel index differences from it.
    for (const fx of FRACTIONS) {
      for (const fy of FRACTIONS) {
        const dot = { x: 64 + fx, y: 64 + fy }
        const { p, renderer } = pipelineWithDot(dot)
        const markCentre = { x: Math.floor(dot.x) + 0.5, y: Math.floor(dot.y) + 0.5 }
        for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          expect(reach(p, renderer, markCentre, sx, sy)).toBeGreaterThan(8 - 2 * STEP)
          expect(reach(p, renderer, markCentre, sx, sy)).toBeLessThanOrEqual(8)
        }
        p.dispose()
      }
    }
  })

  it('no longer leans toward the top-left once averaged over sub-pixel placements', () => {
    // Measured from the DOT rather than the mark, a residual remains: the lit
    // pixel's centre is up to half a pixel from the dot, so the region is that
    // much off-centre. That part is unavoidable at one pixel per vertex.
    //
    // What matters is that it no longer accumulates. The old bias was
    // 2 * fract(dot) -- always positive, always toward -x and -y -- so it
    // averaged a whole pixel of lean up and to the left. Now it is
    // 2 * fract(dot) - 1, which averages out.
    let leanX = 0
    let leanY = 0
    for (const f of FRACTIONS) {
      const dot = { x: 64 + f, y: 64 + f }
      const { p, renderer } = pipelineWithDot(dot)
      leanX += reach(p, renderer, dot, -1, 0) - reach(p, renderer, dot, +1, 0)
      leanY += reach(p, renderer, dot, 0, -1) - reach(p, renderer, dot, 0, +1)
      p.dispose()
    }
    expect(Math.abs(leanX / FRACTIONS.length)).toBeLessThanOrEqual(0.2)
    expect(Math.abs(leanY / FRACTIONS.length)).toBeLessThanOrEqual(0.2)
  })

  it('bounds the residual at the half pixel the mark itself costs', () => {
    // The worst case, so a regression that reintroduces a whole-pixel error
    // cannot hide inside the average above.
    for (const f of FRACTIONS) {
      const dot = { x: 64 + f, y: 64 + f }
      const { p, renderer } = pipelineWithDot(dot)
      const leanX = reach(p, renderer, dot, -1, 0) - reach(p, renderer, dot, +1, 0)
      const leanY = reach(p, renderer, dot, 0, -1) - reach(p, renderer, dot, 0, +1)
      // |2f - 1| <= 1, plus a sweep step.
      expect(Math.abs(leanX)).toBeLessThanOrEqual(1 + 2 * STEP)
      expect(Math.abs(leanY)).toBeLessThanOrEqual(1 + 2 * STEP)
      p.dispose()
    }
  })

  it('holds the reach at the full radius, not a pixel short of it', () => {
    // The read window is widened by a pixel each side so the disc is never
    // clipped; this pins that the extra ring supplies pixels without the reach
    // quietly growing or shrinking.
    const dot = { x: 64.5, y: 64.5 }  // dead centre of its pixel
    const { p, renderer } = pipelineWithDot(dot)
    for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      expect(reach(p, renderer, dot, sx, sy)).toBeCloseTo(8, 1)
    }
    p.dispose()
  })
})
