import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { DragSnapIndicator } from '@/components/Geometry3D/Dragging'
import { COLOR_SNAP } from '@/components/Geometry3D/constants'

/**
 * The snap overlay is a pure store projection: a dot exactly when a snap is live.
 */

const MockDot = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {}, gl: {} }),
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
}))

beforeEach(() => {
  MockDot.mockClear()
  useSketchEditorStore.setState({ drag: null, dragSnap: null })
})

describe('DragSnapIndicator', () => {
  it('renders nothing without a snap target', () => {
    expect(render(<DragSnapIndicator />).container.firstChild).toBeNull()
  })

  it('renders a snap dot at the target position', () => {
    useSketchEditorStore.setState({
      dragSnap: { kind: 'vertex', position: [3, 4], constraintKind: 'coincident' },
    })
    render(<DragSnapIndicator />)
    expect(MockDot).toHaveBeenCalledWith(expect.objectContaining({ x: 3, y: 4, px: 6, color: COLOR_SNAP }))
  })
})
