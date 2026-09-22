import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

/**
 * The shared dimension label. It owns two decisions the renderers rely on: the
 * invisible hit circle is dropped while dragging (so a drag cannot re-pick
 * itself), and the Html handlers only fire when the dim is interactive. The
 * userSelect fallback is what lets the diameter label stay selectable.
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

function handlers() {
  return {
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onPointerDown: vi.fn(),
  }
}

function renderLabel(props: Partial<React.ComponentProps<typeof DimensionLabel>> = {}) {
  const h = handlers()
  const utils = render(
    <DimensionLabel
      x={3} y={4} label="R5" color="#ffd54f" interactive isDragged={false}
      onClick={h.onClick} onDoubleClick={h.onDoubleClick} onPointerDown={h.onPointerDown}
      {...props}
    />,
  )
  return { ...utils, ...h }
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
  it('shows the label text and disables pointer events when not interactive', () => {
    const { getByTestId } = renderLabel({ interactive: false })

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
})

describe('DimensionLabel handlers', () => {
  it('forwards click, double-click and pointer-down while interactive', () => {
    const { container, onClick, onDoubleClick, onPointerDown } = renderLabel()
    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement

    fireEvent.click(div)
    fireEvent.doubleClick(div, { clientX: 11, clientY: 22 })
    // jsdom's pointer events do not carry client coords, so dispatch one that does.
    fireEvent(div, new MouseEvent('pointerdown', { bubbles: true, clientX: 33, clientY: 44 }))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ clientX: 11, clientY: 22 }))
    expect(onPointerDown).toHaveBeenCalledWith(expect.objectContaining({ clientX: 33, clientY: 44 }))
  })

  it('is inert when not interactive', () => {
    const { container, onClick, onDoubleClick, onPointerDown } = renderLabel({ interactive: false })
    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement

    fireEvent.click(div)
    fireEvent.doubleClick(div)
    fireEvent.pointerDown(div)

    expect(onClick).not.toHaveBeenCalled()
    expect(onDoubleClick).not.toHaveBeenCalled()
    expect(onPointerDown).not.toHaveBeenCalled()
  })
})
