import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

const MockDot = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
  VertexHighlight: () => null,
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

vi.mock('@/components/sketch_helpers', () => ({
  p2w: () => 1,
}))

beforeEach(() => {
  MockDot.mockClear()
  useSketchEditorStore.setState({
    normalSelection: new Set(),
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
})
