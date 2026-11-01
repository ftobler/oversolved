import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

/**
 * The shared dimension label. It owns two decisions the renderers rely on: the
 * invisible hit circle is dropped while dragging (so a drag cannot re-pick
 * itself), and the text never takes the pointer. The latter is what makes the
 * id-buffer ring the single hover/click path for a label: a pointer-events
 * auto text block is a canvas sibling, so entering it fires the canvas
 * pointerleave (dropping the hover) and its DOM click bypasses the dispatcher.
 * The userSelect fallback is what lets the diameter label stay selectable where
 * the browser has a selection to make.
 */

vi.mock('@react-three/drei', () => ({
  Html: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div data-testid="html" data-pointer={style?.pointerEvents}>{children}</div>
  ),
}))

vi.mock('../useDimLabelScale', () => ({
  useDimLabelScale: () => ({ current: null }),
}))

import { DimensionLabel } from '../DimensionLabel'

function renderLabel(props: Partial<React.ComponentProps<typeof DimensionLabel>> = {}) {
  return render(
    <DimensionLabel
      x={3} y={4} label="R5" color="#ffd54f" isDragged={false}
      {...props}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DimensionLabel hit mesh', () => {
  it('renders the hit circle at the label position with the shared z offset', () => {
    const { container } = renderLabel()

    const mesh = container.querySelector('mesh')!
    expect(mesh.getAttribute('position')).toBe(`3,4,${LABEL_Z_OFFSET}`)
    expect(mesh.querySelector('circleGeometry')).not.toBeNull()
  })

  it('drops the hit circle while the label is being dragged', () => {
    const { container } = renderLabel({ isDragged: true })

    expect(container.querySelector('mesh')).toBeNull()
    // The text itself stays visible mid-drag.
    expect(container.textContent).toBe('R5')
  })
})

describe('DimensionLabel text', () => {
  it('never takes pointer events, so hover and click stay with the ID ring', () => {
    const { getByTestId } = renderLabel()

    expect(getByTestId('html').getAttribute('data-pointer')).toBe('none')
  })

  it('omits userSelect when selectable is false, keeping the text copyable', () => {
    const { container } = renderLabel({ selectable: false })

    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement
    expect(div.style.userSelect).toBe('')
    expect(div.getAttribute('style')).not.toContain('user-select')
  })

  it('sets userSelect none by default', () => {
    const { container } = renderLabel()

    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement
    expect(div.style.userSelect).toBe('none')
  })

  // The label sits under the cursor while a dim is dragged, so an opaque box
  // would hide the vertex the user is aiming at.
  it('has no background fill while dragged', () => {
    const { container } = renderLabel({ isDragged: true })

    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement
    expect(div.style.background).toBe('transparent')
  })

  // With no box behind it, the halo is what keeps the digits readable where
  // they cross sketch lines.
  it('draws a text halo in place of the box', () => {
    const { container } = renderLabel()

    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement
    expect(div.style.textShadow).toContain('#111')
  })
})
