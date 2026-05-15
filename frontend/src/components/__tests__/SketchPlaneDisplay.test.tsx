import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SketchPlaneDisplay } from '@/components/Viewport'

const MockText = vi.fn(({ children }: { children: string }) => (
  <div data-testid="sketch-label">{children}</div>
))

vi.mock('@react-three/drei', () => ({
  Line: () => null,
  Text: (props: { children: string }) => {
    MockText(props)
    return null
  },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))



describe('SketchPlaneDisplay', () => {
  beforeEach(() => {
    MockText.mockClear()
  })

  it('renders label when sketchLabel is provided', () => {
    render(
      <SketchPlaneDisplay
        planeQuery="@builtin_plane_front"
        size={100}
        sketchLabel="Sketch 1"
      />
    )

    expect(MockText).toHaveBeenCalled()
    const textCall = MockText.mock.calls[0][0]
    expect(textCall.children).toBe('Sketch 1')
  })

  it('renders without label when sketchLabel is not provided', () => {
    render(
      <SketchPlaneDisplay
        planeQuery="@builtin_plane_front"
        size={100}
      />
    )

    expect(MockText).not.toHaveBeenCalled()
  })

  it('returns null for non-builtin planes', () => {
    const { container } = render(
      <SketchPlaneDisplay
        planeQuery="@feature_123"
        size={100}
        sketchLabel="Custom"
      />
    )

    expect(container.innerHTML).toBe('')
  })
})
