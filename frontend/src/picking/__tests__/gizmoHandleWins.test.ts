// The regression guard for the bug that shipped: the assembly triad drew on
// top of its part but was picked behind it, so no arrow or ring was grabbable
// on any part bigger than the gizmo. Nothing bound the rendered handles to the
// gesture adapter, so every triad unit test passed while the gizmo was dead.
//
// The gizmo now lives in its own ID layer at priority 90. This asserts the rule
// that makes it grabbable, at the resolver level, with no canvas involved.

import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { resolvePixelWindow, resolvePixelWindowAll } from '../IdResolver'
import { idToRGB } from '../idEncoding'
import { DEFAULT_WINDOW_SIZE, IdPipeline } from '../IdPipeline'
import {
  FACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
} from '../layerNames'
import {
  ARROW_PICK_RADIUS, ARROW_PICK_START, GIZMO_PIXELS, PLANE_INNER, RING_PICK_TUBE,
} from '@/utils/gizmoPickGeometry'

function fillPixel(buf: Uint8Array, size: number, x: number, y: number, id: number): void {
  const [r, g, b] = idToRGB(id)
  const i = (y * size + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = 255
}

const SIZE = 17

describe('gizmo handle layer priority', () => {
  let reg: IdRegistry
  let faceId: number
  let gizmoId: number
  let priority: Readonly<Record<string, number>>

  beforeEach(() => {
    reg = new IdRegistry()
    faceId = reg.allocate(FACE_LAYER_NAME, 'face@part')
    gizmoId = reg.allocate(GIZMO_HANDLE_LAYER_NAME, 'gizmo:translate:x')
    // Read the real map off the pipeline rather than hand-writing numbers, so a
    // future re-priorisation cannot leave this test asserting a stale ordering.
    priority = new IdPipeline({ width: 4, height: 4 }).getLayerPriority()
  })

  it('a handle pixel beats a face pixel at the very same spot', () => {
    const buf = new Uint8Array(SIZE * SIZE * 4)
    fillPixel(buf, SIZE, 8, 8, faceId)
    fillPixel(buf, SIZE, 8, 8, gizmoId)  // gizmo layer renders last, overwrites
    const hit = resolvePixelWindow(buf, SIZE, reg, undefined, priority)
    expect(hit!.layer).toBe(GIZMO_HANDLE_LAYER_NAME)
  })

  it('a handle pixel further from the cursor still beats a nearer face', () => {
    // The real geometry: the arrow is thin and the body fills the window around
    // it. Distance alone would hand the grab to the body every time.
    const buf = new Uint8Array(SIZE * SIZE * 4)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) fillPixel(buf, SIZE, x, y, faceId)
    }
    fillPixel(buf, SIZE, 13, 8, gizmoId)  // 5 px off centre
    const hit = resolvePixelWindow(buf, SIZE, reg, undefined, priority)
    expect(hit!.layer).toBe(GIZMO_HANDLE_LAYER_NAME)
    expect(hit!.entityKey).toBe('gizmo:translate:x')
  })

  it('outranks the part editor feature handle layer too', () => {
    const handleId = reg.allocate(FEATURE_HANDLE_LAYER_NAME, 'fhandle:f1:distance')
    const buf = new Uint8Array(SIZE * SIZE * 4)
    fillPixel(buf, SIZE, 8, 8, handleId)
    fillPixel(buf, SIZE, 12, 8, gizmoId)
    const hit = resolvePixelWindow(buf, SIZE, reg, undefined, priority)
    expect(hit!.layer).toBe(GIZMO_HANDLE_LAYER_NAME)
  })

  it('the assembly entity filter hides handles from the mate picker', () => {
    // Selection and mate aiming resolve a narrower layer set; a triad handle is
    // a drag affordance and must never become a mate reference.
    const buf = new Uint8Array(SIZE * SIZE * 4)
    fillPixel(buf, SIZE, 8, 8, gizmoId)
    fillPixel(buf, SIZE, 2, 2, faceId)
    const hits = resolvePixelWindowAll(buf, SIZE, reg, new Set([FACE_LAYER_NAME]), priority)
    expect(hits.map(h => h.layer)).toEqual([FACE_LAYER_NAME])
  })
})

// Layer priority settles gizmo-vs-world. What settles gizmo-vs-gizmo is plain
// distance, and that only means anything if the handles do not smear into each
// other's pixels first. The triad's grab regions are hairlines for that reason:
// the snap radius below is the only tolerance the user needs.
describe('triad handles stay out of each others snap windows', () => {
  const snapRadiusPx = (DEFAULT_WINDOW_SIZE - 1) / 2
  // The triad is screen-scaled so one gizmo-local unit is GIZMO_PIXELS pixels.
  const px = (local: number) => local * GIZMO_PIXELS

  it('an arrow and the plane quad beside it are a whole window apart', () => {
    // Aiming at the arrow, the plane quad is not even inside the window that
    // gets read, so it cannot take the grab. The old fat tube left a gap of
    // roughly 14 px here, well inside one window.
    expect(px(PLANE_INNER - ARROW_PICK_RADIUS)).toBeGreaterThanOrEqual(DEFAULT_WINDOW_SIZE)
  })

  it('an arrow and a ring overlap over a couple of pixels where they cross', () => {
    // An arrow runs straight through the two rings at their major radius, so
    // some ambiguity there is unavoidable. What matters is its size: the span
    // in which a pixel could belong to either is the two tube widths, which
    // stays well inside the snap radius so the nearest-pixel rule decides by
    // aim rather than by which triangle rasterized last.
    expect(px(2 * (ARROW_PICK_RADIUS + RING_PICK_TUBE))).toBeLessThan(snapRadiusPx)
  })

  it('a click on the part origin itself grabs no arrow', () => {
    // ARROW_PICK_START keeps the hub clear; it only holds if the gap it leaves
    // outruns the snap radius, or the resolver would reach in and find an arrow.
    expect(px(ARROW_PICK_START)).toBeGreaterThan(snapRadiusPx)
  })
})
