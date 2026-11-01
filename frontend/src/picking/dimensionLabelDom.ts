// The dimension label's truthful pick footprint.
//
// A label is a DOM overlay (drei `<Html>`), not ID-buffer geometry: its text is
// laid out by the browser at a constant screen size, horizontal to the screen at
// every camera pose, and its width depends on the formatted value. The ID pass
// can only offer a point (the ring) and a circular pick window, so a label wider
// than that disc lost its outer glyphs: a click there fell through to the
// geometry behind it or was a viewport miss that cleared the selection, and
// hover never reached the text at all.
//
// So the label registers its own rendered text element here, and the dispatcher
// asks this registry before it reads the ID buffer. The answer is a synthetic
// ResolvedHit for the dimensionLabel layer: every downstream step (hover
// adapter, click swallow verdict, double-click, drag start) is the same code
// path the ring's hit takes, so this is a better hit test, not a second dispatch.
//
// `pointer-events` stays `none` on the text, so pointer events keep flowing to
// the canvas listeners that make this check possible.

import { DIMENSION_LABEL_LAYER_NAME } from './layerNames'
import type { ResolvedHit } from './IdResolver'

const boxes = new Map<string, HTMLElement>()

/** The registry's dimensions hit's synthetic id. Nothing downstream resolves it. */
const DOM_HIT_ID = 0

/**
 * Publish one interactive label's text element under its constraint id. The
 * caller owns the gate (an interactive, not-dragged label), matching the ring's
 * registration gate, so a label that is not pickable stays pickable nowhere.
 * Returns the unregister; identity-guarded so a remount cannot drop the newer
 * element.
 */
export function registerDimensionLabelElement(cid: string, element: HTMLElement | null): () => void {
  if (!element) return () => {}
  boxes.set(cid, element)
  return () => {
    if (boxes.get(cid) === element) boxes.delete(cid)
  }
}

/**
 * The label whose rendered text contains the client point, or null.
 *
 * A zero-sized box means the element is not laid out (unmounted, or a headless
 * test without layout), which is not a truthful footprint: skip it rather than
 * claim a point at (0, 0). Overlapping labels resolve to the nearest centre so
 * the answer does not depend on registration order.
 */
export function dimensionLabelDomHit(clientX: number, clientY: number): ResolvedHit | null {
  let bestCid: string | null = null
  let bestDistance = Infinity
  for (const [cid, element] of boxes) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const distance = Math.hypot(clientX - cx, clientY - cy)
    if (distance < bestDistance) {
      bestDistance = distance
      bestCid = cid
    }
  }
  if (bestCid === null) return null
  const entityKey = `dim:${bestCid}`
  return { id: DOM_HIT_ID, layer: DIMENSION_LABEL_LAYER_NAME, entityKey, distancePx: 0 }
}

/** Drop every registered element. Tests only: a suite must not inherit another's labels. */
export function resetDimensionLabelDomBoxesForTest(): void {
  boxes.clear()
}
