import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DrawPreview } from '@/components/Geometry3D/Drawing'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'

// The preview's three.js primitives are stubbed to divs that expose the points
// they were handed, so the rubber band's endpoint can be read back.
vi.mock('@react-three/fiber', () => ({ useThree: () => ({}) }))
vi.mock('@react-three/drei', () => ({
  Line: ({ points }: { points: number[][] }) => (
    <div data-testid="preview-line" data-points={JSON.stringify(points)} />
  ),
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: ({ x, y }: { x: number; y: number }) => <div data-testid="preview-dot" data-xy={JSON.stringify([x, y])} />,
}))
vi.mock('@/components/Geometry3D/dimensions', () => ({
  DashedLine: () => <div data-testid="preview-dashed" />,
}))

function linePoints(el: HTMLElement | null): number[][] {
  return JSON.parse(el?.getAttribute('data-points') ?? 'null')
}

describe('DrawPreview follows the committed snap', () => {
  beforeEach(() => {
    initializeTools()
    useSketchEditorStore.setState({
      activeTool: 'line',
      drawPoints: [[0, 0]],
      drawSnapRefs: [null],
      drawHover: [5.2, 4.9],
      hoveredVertexId: 'vertex:S1:V1:end',
      hoveredVertexPosition: [5, 5],
      hoveredSnapKind: 'vertex',
      hoveredSelectionId: null,
      alignmentSnapPoint: null,
      alignmentSnapKind: null,
    })
  })

  it('ends the line preview on the hovered vertex, not the raw cursor', () => {
    const { getByTestId } = render(<DrawPreview featureId="S1" activeFeatureId="S1" />)
    expect(linePoints(getByTestId('preview-line'))).toEqual([[0, 0, 0], [5, 5, 0]])
  })

  it('previews the point tool at the snapped position', () => {
    useSketchEditorStore.setState({ activeTool: 'point', drawPoints: [], drawSnapRefs: [] })
    const { getByTestId } = render(<DrawPreview featureId="S1" activeFeatureId="S1" />)
    expect(JSON.parse(getByTestId('preview-dot').getAttribute('data-xy') ?? 'null')).toEqual([5, 5])
  })

  it('ends on the foot of a hovered curve when given the sketch geometry', () => {
    useSketchEditorStore.setState({
      hoveredVertexId: null, hoveredVertexPosition: null, hoveredSnapKind: null,
      hoveredSelectionId: 'entity:S1:L1', drawHover: [4, 3], drawPoints: [[0, 5]],
    })
    const sketch = { L1: { start: [0, 0], end: [10, 0] } } as unknown as import('@/types/cad').Sketch
    const { getByTestId } = render(<DrawPreview featureId="S1" activeFeatureId="S1" sketch={sketch} />)
    expect(linePoints(getByTestId('preview-line'))).toEqual([[0, 5, 0], [4, 0, 0]])
  })
})
