import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Sketch, Constraints } from '@/types/cad'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { dimensionLabelDomHit, resetDimensionLabelDomBoxesForTest } from '@/picking/dimensionLabelDom'
import { getSceneHandles, resetSceneProbeStore } from '@/picking/sceneProbeStore'

/**
 * A dimension label is a DOM text block (drei `<Html>`), not ID-buffer geometry,
 * so it registers its own box with `picking/dimensionLabelDom` and a fallback ID
 * point with the scene probe. Both registrations live in the dimension
 * component's lifecycle, so hiding a dimension while the geometry is stale has
 * to unmount it, not just skip painting: an orphaned box would still answer a
 * hover or a click at the label's pre-drag position. This pins that the unmount
 * is what closes the pick path.
 */

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {} }),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: React.ReactNode }) => <div data-testid="html-wrapper">{children}</div>,
  Line: () => null,
}))

vi.mock('@/components/Geometry3D/dimensions/primitives', () => ({
  Arrowhead: () => null,
  ArrowTail: () => null,
  ExtensionLine: () => null,
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

const sketch: Sketch = {
  line1: { kind: 'lineSegment', start: [0, 0], end: [10, 0] } as Sketch[string],
}

const dimensions: Constraints = {
  d1: { render: { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 }, residual: 0 } as Constraints[string],
}

function overlays(geometryStale: boolean) {
  return (
    <ConstraintOverlays
      constraints={dimensions}
      sketch={sketch}
      extent={10}
      featureId="feat1"
      geometryStale={geometryStale}
    />
  )
}

beforeEach(() => {
  useSketchUiStore.setState({ showConstraintTiles: true })
  resetDimensionLabelDomBoxesForTest()
  resetSceneProbeStore()
  // jsdom has no layout, so the label's text div would report a zero box and the
  // hit test would skip it by design. Give the glyph box a footprint.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: -10, y: -10, top: -10, left: -10, right: 10, bottom: 10, width: 20, height: 20,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a hidden dimension leaves no pick target behind', () => {
  it('drops both the label DOM box and the ID point when the geometry goes stale', () => {
    const { rerender } = render(overlays(false))
    expect(dimensionLabelDomHit(0, 0)?.entityKey).toBe('dim:d1')
    // The probe's pick key is the bare entity key, not the label source key.
    expect(getSceneHandles('dim:d1')).toHaveLength(1)

    rerender(overlays(true))
    expect(dimensionLabelDomHit(0, 0)).toBeNull()
    expect(getSceneHandles('dim:d1')).toHaveLength(0)

    // Back to live: the remount registers exactly one box and one point again.
    // The registry's identity guard must not let the earlier unmount drop the
    // new element.
    rerender(overlays(false))
    expect(dimensionLabelDomHit(0, 0)?.entityKey).toBe('dim:d1')
    expect(getSceneHandles('dim:d1')).toHaveLength(1)

    rerender(overlays(true))
    expect(dimensionLabelDomHit(0, 0)).toBeNull()
    expect(getSceneHandles('dim:d1')).toHaveLength(0)
  })
})
