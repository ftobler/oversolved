import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DrawPreview } from '@/components/Geometry3D/Drawing'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'

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
    // The draw-plane classification is registry-backed, so the canonical tools
    // must be registered before the preview can recognize the line tool.
    initializeTools()
    // Two draw points + a line tool produce a non-empty preview polyline.
    useSketchEditorStore.setState({
      activeTool: 'line',
      drawPoints: [[0, 0]],
      drawHover: [10, 0],
      alignmentSnapPoint: null,
      alignmentSnapKind: null,
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

  it('renders nothing for a non-drawing tool', () => {
    useSketchEditorStore.setState({ activeTool: 'drag' })
    const { queryByTestId } = render(<DrawPreview featureId="S2" activeFeatureId="S2" />)
    expect(queryByTestId('preview-line')).toBeNull()
    expect(queryByTestId('preview-dot')).toBeNull()
  })

  it('draws an extra hover dot for the point tool only', () => {
    useSketchEditorStore.setState({ activeTool: 'point', drawPoints: [[0, 0]], drawHover: [10, 0] })
    const { queryAllByTestId } = render(<DrawPreview featureId="S2" activeFeatureId="S2" />)
    // One dot for the placed point, one for the live cursor.
    expect(queryAllByTestId('preview-dot')).toHaveLength(2)
  })

  it('draws the alignment guide only when an alignment snap is live', () => {
    useSketchEditorStore.setState({ alignmentSnapPoint: [5, 5], alignmentSnapKind: 'kinda_horizontal' })
    const withSnap = render(<DrawPreview featureId="S2" activeFeatureId="S2" />)
    expect(withSnap.queryByTestId('preview-dashed')).not.toBeNull()
    withSnap.unmount()

    // A snap point without a kind must not draw a guide to nowhere.
    useSketchEditorStore.setState({ alignmentSnapPoint: [5, 5], alignmentSnapKind: null })
    const withoutKind = render(<DrawPreview featureId="S2" activeFeatureId="S2" />)
    expect(withoutKind.queryByTestId('preview-dashed')).toBeNull()
  })
})
