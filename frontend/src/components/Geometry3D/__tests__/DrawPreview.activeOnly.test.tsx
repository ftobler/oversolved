import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DrawPreview } from '@/components/Geometry3D/Drawing'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// The preview is composed of three.js primitives (drei Line, Dot, DashedLine)
// that need no WebGL context to render as host elements under jsdom; we only
// assert presence/absence of emitted children, so stub them to plain divs.
vi.mock('@react-three/fiber', () => ({ useThree: () => ({}) }))
vi.mock('@react-three/drei', () => ({
  Line: () => <div data-testid="preview-line" />,
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: () => <div data-testid="preview-dot" />,
}))
vi.mock('@/components/Geometry3D/dimensions', () => ({
  DashedLine: () => <div data-testid="preview-dashed" />,
}))

describe('DrawPreview active-feature guard', () => {
  beforeEach(() => {
    // Two draw points + a line tool produce a non-empty preview polyline.
    useSketchEditorStore.setState({
      activeTool: 'line',
      drawPoints: [[0, 0]],
      drawHover: [10, 0],
    })
  })

  it('renders the preview on the active sketch', () => {
    const { queryByTestId } = render(
      <DrawPreview featureId="S2" activeFeatureId="S2" />
    )
    expect(queryByTestId('preview-line')).not.toBeNull()
  })

  it('renders nothing on a non-active visible sketch', () => {
    // Regression: previously the preview was drawn inside every sketch group,
    // so an inactive sketch on a different plane double-rendered the cursor
    // geometry on the wrong plane during insertion.
    const { queryByTestId } = render(
      <DrawPreview featureId="S1" activeFeatureId="S2" />
    )
    expect(queryByTestId('preview-line')).toBeNull()
    expect(queryByTestId('preview-dot')).toBeNull()
  })
})
