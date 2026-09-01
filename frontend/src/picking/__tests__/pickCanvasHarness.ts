import * as THREE from 'three'
import { idToRGB } from '../idEncoding'

/**
 * A whole ID buffer under test, addressed the way the rest of the app addresses
 * it: canvas pixels, top-left origin.
 *
 * The existing resolver tests hand `resolvePixelWindow` a pre-cut 17x17 window,
 * so they exercise the scan but not the two conversions in front of it -- where
 * the window is cut from, and which way up its rows are stitched. Those are the
 * halves that can put the scanned region beside the cursor rather than around
 * it, and neither is reachable without going through `IdPipeline.readWindow`.
 * This serves a full image to that path instead, so a test can say "the mark is
 * at canvas (x, y)" and mean the same thing the user's cursor does.
 */
export class IdImage {
  readonly width: number
  readonly height: number
  // Row-major RGBA, row 0 = TOP of the canvas.
  private readonly px: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.px = new Uint8Array(width * height * 4)
  }

  // Paint one canvas pixel with `id`, overwriting whatever was there.
  mark(x: number, y: number, id: number): this {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return this
    const [r, g, b] = idToRGB(id)
    const i = (y * this.width + x) * 4
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = 255
    return this
  }

  // Paint every pixel within `radius` of (cx, cy) -- an area primitive.
  disc(cx: number, cy: number, radius: number, id: number): this {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (Math.hypot(x - cx, y - cy) <= radius) this.mark(x, y, id)
      }
    }
    return this
  }

  // A 1 px line from (x0, y0) to (x1, y1), the run of pixels an edge marks.
  line(x0: number, y0: number, x1: number, y1: number, id: number): this {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) * 4 + 1
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      this.mark(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), id)
    }
    return this
  }

  /**
   * A renderer stub whose only job is `readRenderTargetPixels`, with the same
   * bottom-left read origin the real one has: row 0 of the output is the
   * BOTTOM row of the requested region. Getting this backwards is exactly the
   * failure mode the y-flip tests below are looking for, so it is written out
   * from the canvas image rather than shared with the code under test.
   */
  renderer(): THREE.WebGLRenderer {
    return {
      readRenderTargetPixels: (
        _t: unknown, x: number, y: number, w: number, h: number, out: Uint8Array,
      ) => {
        for (let row = 0; row < h; row++) {
          const canvasY = this.height - 1 - (y + row)
          for (let col = 0; col < w; col++) {
            const src = (canvasY * this.width + (x + col)) * 4
            const dst = (row * w + col) * 4
            out[dst] = this.px[src]
            out[dst + 1] = this.px[src + 1]
            out[dst + 2] = this.px[src + 2]
            out[dst + 3] = this.px[src + 3]
          }
        }
      },
    } as unknown as THREE.WebGLRenderer
  }
}
