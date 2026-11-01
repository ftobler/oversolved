import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dimensionLabelDomHit, registerDimensionLabelElement, resetDimensionLabelDomBoxesForTest } from '../dimensionLabelDom'

/**
 * The dimension label's DOM hit test. The rendered text box is the label's
 * truthful footprint, so it is worth pinning on its own: containment, layout
 * safety, overlap order, the identity-guarded unregister, and the one-frame
 * rect memo that keeps a pointermove burst from forcing a layout read per
 * event.
 */

function labelBox(left = 100, top = 50, width = 80, height = 17): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({
    left, top, right: left + width, bottom: top + height,
    width, height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect
  return el
}

function emptyBox(): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0,
    width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect
  return el
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

beforeEach(() => {
  resetDimensionLabelDomBoxesForTest()
})

afterEach(() => {
  resetDimensionLabelDomBoxesForTest()
})

describe('dimensionLabelDomHit', () => {
  it('answers for a point inside the rendered text and nothing outside it', () => {
    registerDimensionLabelElement('c1', labelBox())

    expect(dimensionLabelDomHit(140, 60)).toMatchObject({
      layer: 'dimensionLabel', entityKey: 'dim:c1',
    })
    expect(dimensionLabelDomHit(99, 60)).toBeNull()
    expect(dimensionLabelDomHit(181, 60)).toBeNull()
  })

  it('skips a box that is not laid out rather than claiming a point at the origin', () => {
    registerDimensionLabelElement('c1', emptyBox())

    expect(dimensionLabelDomHit(0, 0)).toBeNull()
    expect(dimensionLabelDomHit(140, 60)).toBeNull()
  })

  it('resolves overlapping labels to the nearest centre', () => {
    registerDimensionLabelElement('left', labelBox(100, 50, 80, 17))
    registerDimensionLabelElement('right', labelBox(160, 50, 80, 17))

    // 175 is inside both; the right box's centre (200) is nearer than 140.
    expect(dimensionLabelDomHit(175, 58)?.entityKey).toBe('dim:right')
    expect(dimensionLabelDomHit(110, 58)?.entityKey).toBe('dim:left')
  })

  it('an identity-guarded unregister cannot drop a newer element', () => {
    const first = labelBox()
    const unregisterFirst = registerDimensionLabelElement('c1', first)
    registerDimensionLabelElement('c1', labelBox(200, 50))

    unregisterFirst()

    // The newer box is still registered at its own position.
    expect(dimensionLabelDomHit(240, 60)?.entityKey).toBe('dim:c1')
    expect(dimensionLabelDomHit(140, 60)).toBeNull()
  })
})

describe('one-frame rect memo', () => {
  it('reads each element at most once per frame, and again on the next frame', async () => {
    const rect = {
      left: 100, top: 50, right: 180, bottom: 67,
      width: 80, height: 17, x: 100, y: 50, toJSON: () => ({}),
    } as DOMRect
    const el = labelBox()
    const read = vi.fn(() => rect)
    el.getBoundingClientRect = read
    registerDimensionLabelElement('c1', el)

    dimensionLabelDomHit(140, 60)
    dimensionLabelDomHit(141, 60)
    dimensionLabelDomHit(142, 60)
    expect(read).toHaveBeenCalledTimes(1)

    await nextFrame()
    dimensionLabelDomHit(140, 60)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
