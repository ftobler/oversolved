import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import { dimensionLabelDomHit, resetDimensionLabelDomBoxesForTest } from '@/picking/dimensionLabelDom'

/**
 * The shared dimension label. It owns the decisions the renderers rely on: the
 * text never takes the pointer (so entering it does not fire the canvas
 * pointerleave and drop the hover), and it publishes its rendered box as the
 * label's pick footprint while it is interactive and not being dragged. The box
 * is the only truthful footprint: the text is laid out by the browser at a
 * constant screen size and its width follows the formatted value, while the ID
 * ring can only offer a point.
 */

vi.mock('@react-three/drei', () => ({
  Html: ({ children, style, position }: { children: React.ReactNode; style?: React.CSSProperties; position?: number[] }) => (
    <div data-testid="html" data-pointer={style?.pointerEvents} data-position={position?.join(',')}>{children}</div>
  ),
}))

import { DimensionLabel } from '../DimensionLabel'

function renderLabel(props: Partial<React.ComponentProps<typeof DimensionLabel>> = {}) {
  return render(
    <DimensionLabel
      cid="c1" x={3} y={4} label="R5" color="#ffd54f" isDragged={false}
      {...props}
    />,
  )
}

// jsdom does not lay text out, so a box has to be supplied. The size below is a
// long label: 80 CSS px wide, 17 high (14 px Roboto Mono plus the 5 px padding).
function stubBox(div: HTMLElement, left = 100, top = 50) {
  div.getBoundingClientRect = () => ({
    left, top, right: left + 80, bottom: top + 17,
    width: 80, height: 17, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDimensionLabelDomBoxesForTest()
})

afterEach(() => {
  resetDimensionLabelDomBoxesForTest()
})

describe('DimensionLabel text', () => {
  it('never takes pointer events, so the canvas listeners keep hearing the pointer', () => {
    const { getByTestId } = renderLabel()

    expect(getByTestId('html').getAttribute('data-pointer')).toBe('none')
  })

  it('renders the label at the shared z offset', () => {
    const { getByTestId } = renderLabel()

    // The text is the label's only visible part; there is no hit mesh to carry
    // the position any more.
    expect(getByTestId('html').getAttribute('data-position')).toBe(`3,4,${LABEL_Z_OFFSET}`)
    expect(getByTestId('html').textContent).toBe('R5')
  })

  it('keeps userSelect off, so a label drag cannot select text', () => {
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

describe('DimensionLabel pick footprint', () => {
  it('publishes the rendered text box, so a click on the far glyphs reaches the label', () => {
    const { container } = renderLabel()
    const div = container.querySelector('[data-testid="html"] > div') as HTMLElement
    stubBox(div, 100, 50)

    // 175 is 75 px from the box centre: far beyond the ring's 8 px reach, and
    // still inside the text the user sees.
    expect(dimensionLabelDomHit(175, 60)).toMatchObject({
      layer: 'dimensionLabel', entityKey: 'dim:c1',
    })
    // Outside the glyph block nothing is claimed.
    expect(dimensionLabelDomHit(99, 60)).toBeNull()
    expect(dimensionLabelDomHit(181, 60)).toBeNull()
  })

  it('publishes nothing without an interaction or while the label is dragged', () => {
    const disabled = renderLabel({ enabled: false })
    const disabledDiv = disabled.container.querySelector('[data-testid="html"] > div') as HTMLElement
    stubBox(disabledDiv)
    expect(dimensionLabelDomHit(140, 60)).toBeNull()

    const dragged = renderLabel({ isDragged: true })
    const draggedDiv = dragged.container.querySelector('[data-testid="html"] > div') as HTMLElement
    stubBox(draggedDiv, 200, 50)
    expect(dimensionLabelDomHit(240, 60)).toBeNull()
  })
})
