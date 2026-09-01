import { describe, it, expect, afterEach } from 'vitest'
import { IdPipeline, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { getPixelRatio } from '@/picking/pickPixelRatio'
import { IdImage } from '@/picking/__tests__/pickCanvasHarness'
import { resolvePickAtEvent, PART_EDITOR_CONSUMED_LAYERS } from '../useIdBufferPointerDispatch'

/**
 * The one conversion the picking tests never crossed: a browser event carries
 * CSS pixels relative to the viewport, and everything downstream of
 * `readWindow` is in the drawing buffer's device pixels. The scale between them
 * is applied in `cursorFromEvent`, and the pick window's own scale is derived
 * separately in `IdPickingDriver`. Two derivations of one ratio is exactly the
 * shape a HiDPI-only failure takes -- and it is invisible at DPR 1, which is
 * what a jsdom suite gets by default unless it says otherwise.
 *
 * These drive the real dispatch entry point (`resolvePickAtEvent`) with real
 * MouseEvents against a canvas whose drawing buffer is larger than its CSS box.
 */

const CSS = 400          // canvas CSS box, px
const LEFT = 37          // a non-zero page offset, so a dropped rect.left shows
const TOP = 91

function canvasAt(dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = CSS * dpr
  canvas.height = CSS * dpr
  canvas.getBoundingClientRect = () => ({
    left: LEFT, top: TOP, width: CSS, height: CSS,
    right: LEFT + CSS, bottom: TOP + CSS, x: LEFT, y: TOP, toJSON: () => ({}),
  })
  return canvas
}

function clickAt(cssX: number, cssY: number): MouseEvent {
  return new MouseEvent('click', { clientX: LEFT + cssX, clientY: TOP + cssY })
}

let live: IdPipeline | null = null
afterEach(() => {
  setLivePipeline(null, live)
  live?.dispose()
  live = null
})

/** A pipeline + image sized like the canvas's drawing buffer at `dpr`. */
function sceneAt(dpr: number) {
  const canvas = canvasAt(dpr)
  const image = new IdImage(canvas.width, canvas.height)
  const p = new IdPipeline({
    width: canvas.width,
    height: canvas.height,
    // Exactly what IdPickingDriver derives each frame.
    pixelRatio: getPixelRatio(canvas.width, CSS),
  })
  p.target.markClean()
  live = p
  setLivePipeline(p)
  return { canvas, image, p, gl: image.renderer() }
}

describe('cursor conversion: an event lands on the pixel the user aimed at', () => {
  for (const dpr of [1, 2, 3]) {
    it(`maps a CSS click to its own device pixel at dpr ${dpr}`, () => {
      const { canvas, image, p, gl } = sceneAt(dpr)
      // A mark exactly under a CSS position, and another one two CSS pixels
      // away in each direction, so a scale error of even one step is caught.
      const aim = { x: 200, y: 150 }
      const here = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'here')
      image.mark(Math.floor(aim.x * dpr), Math.floor(aim.y * dpr), here)
      const hit = resolvePickAtEvent(clickAt(aim.x, aim.y), canvas, gl, PART_EDITOR_CONSUMED_LAYERS)
      expect(hit?.entityKey).toBe('here')
    })

    it(`keeps the 8 CSS px reach at dpr ${dpr}`, () => {
      const { canvas, image, p, gl } = sceneAt(dpr)
      const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'dot')
      // The dot sits at the centre of a device pixel at CSS (200, 150).
      const mx = Math.floor(200 * dpr)
      const my = Math.floor(150 * dpr)
      image.mark(mx, my, id)
      const reachCss = (() => {
        let best = 0
        for (let k = 0; k <= 16; k += 0.05) {
          const hit = resolvePickAtEvent(
            clickAt((mx + 0.5) / dpr + k, (my + 0.5) / dpr), canvas, gl, PART_EDITOR_CONSUMED_LAYERS,
          )
          if (!hit) break
          best = k
        }
        return best
      })()
      // 8 CSS px, up to the half-device-pixel the odd window rebuild can add.
      expect(reachCss).toBeGreaterThan(7.9)
      expect(reachCss).toBeLessThanOrEqual(8 + 0.5 / dpr + 0.05)
    })

    it(`lets a sketch point outrank the curve through it at dpr ${dpr}`, () => {
      // The user-visible claim, driven from a real event at a real DPR: the
      // point wins from anywhere within its reach, the curve only outside it.
      const { canvas, image, p, gl } = sceneAt(dpr)
      const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'curve')
      const point = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'point')
      const cy = Math.floor(150 * dpr)
      image.line(0, cy, canvas.width - 1, cy, curve)
      image.mark(Math.floor(200 * dpr), cy, point)
      for (let dxCss = 0; dxCss <= 12; dxCss += 0.5) {
        const hit = resolvePickAtEvent(clickAt(200 + dxCss, 150), canvas, gl, PART_EDITOR_CONSUMED_LAYERS)
        expect(hit).not.toBeNull()
        const want = dxCss <= 7.5 ? 'point' : dxCss >= 8.6 ? 'curve' : hit!.entityKey
        expect({ dpr, dxCss, won: hit!.entityKey }).toEqual({ dpr, dxCss, won: want })
      }
    })
  }

  it('offsets by the canvas box, not the page origin', () => {
    // A dropped rect.left/top shifts every pick by the canvas's page position,
    // which on a viewport with a sidebar is tens of pixels -- always the same
    // direction, which is what "the pick is beside the cursor" feels like.
    const { canvas, image, p, gl } = sceneAt(2)
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'dot')
    image.mark(0, 0, id)  // top-left device pixel of the buffer
    expect(resolvePickAtEvent(clickAt(0, 0), canvas, gl, PART_EDITOR_CONSUMED_LAYERS)?.entityKey).toBe('dot')
    // The same client point read without the box offset would be LEFT/TOP CSS
    // px into the canvas, far outside the 8 px reach of the corner mark.
    expect(resolvePickAtEvent(
      new MouseEvent('click', { clientX: 0, clientY: 0 }), canvas, gl, PART_EDITOR_CONSUMED_LAYERS,
    )).toBeNull()
  })

  it('derives the same ratio the cursor scale uses', () => {
    // `cursorFromEvent` scales by canvas.width / rect.width; the driver scales
    // the window by getPixelRatio(drawingBuffer, cssWidth). They are two
    // derivations of one number, and a pick is only centred while they agree.
    for (const dpr of [1, 1.5, 2, 3]) {
      const canvas = canvasAt(dpr)
      const cursorScale = canvas.width / canvas.getBoundingClientRect().width
      expect(getPixelRatio(canvas.width, CSS)).toBeCloseTo(cursorScale, 12)
    }
  })
})
