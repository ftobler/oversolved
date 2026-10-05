import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE } from '@/components/Geometry3D/constants'

const MockDot = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
  VertexHighlight: () => null,
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

vi.mock('@/utils/geometry/sketchHelpers', () => ({
  p2w: () => 1,
}))

beforeEach(() => {
  MockDot.mockClear()
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    hoveredSelectionId: null,
    activeFeatureId: null,
    activeTool: null,
    isRotating: false,
    setHoveredSelectionId: vi.fn(),
    setHoveredVertex: vi.fn(),
  } as never)
})

describe('OriginMarker render order', () => {
  it('Dot receives renderOrder > 100', async () => {
    const { default: OriginMarker } = await import('@/components/Viewport/OriginMarker')
    render(<OriginMarker />)
    expect(MockDot).toHaveBeenCalled()
    const props = MockDot.mock.calls[0]?.[0] as Record<string, unknown>
    expect(typeof props.renderOrder).toBe('number')
    expect((props.renderOrder as number) > 100).toBe(true)
  })

  it('Dot receives depthTest={false}', async () => {
    const { default: OriginMarker } = await import('@/components/Viewport/OriginMarker')
    render(<OriginMarker />)
    const props = MockDot.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.depthTest).toBe(false)
  })

  it('uses the hover colour and grows the dot while hovered', async () => {
    useSketchEditorStore.setState({ hoveredSelectionId: '@builtin_origin' })
    const { default: OriginMarker } = await import('@/components/Viewport/OriginMarker')
    render(<OriginMarker />)
    const props = MockDot.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.color).toBe(COLOR_HOVER)
    expect(props.px).toBe(6)
  })

  it('uses the selected colour at the resting size when only selected', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@builtin_origin']) })
    const { default: OriginMarker } = await import('@/components/Viewport/OriginMarker')
    render(<OriginMarker />)
    const props = MockDot.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.color).toBe(COLOR_SELECTED)
    expect(props.px).toBe(4)
  })

  it('uses the inactive colour when neither hovered nor selected', async () => {
    const { default: OriginMarker } = await import('@/components/Viewport/OriginMarker')
    render(<OriginMarker />)
    const props = MockDot.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.color).toBe(COLOR_INACTIVE)
  })
})
