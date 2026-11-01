import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
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
 *
 * The `<Html>` mock reproduces drei's nested React root, because that is what
 * breaks a registration written as a passive effect: the child subtree commits
 * AFTER this component's effects, so `ref.current` is still null when they run.
 * The callback ref must attach when the inner root commits. This mock is the
 * regression: a passive-effect version of DimensionLabel fails these tests.
 */

vi.mock('@react-three/drei', async () => {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  // drei creates its own container, appends it, then renders its wrapper (with
  // the caller's style and children) into a separate root. The subtree is a
  // different React root, which is the whole point.
  function HtmlMock({ children, style, position }: {
    children: React.ReactNode
    style?: React.CSSProperties
    position?: number[]
  }) {
    const [container] = React.useState(() => document.createElement('div'))
    const rootRef = React.useRef<{ render: (node: React.ReactNode) => void; unmount: () => void } | null>(null)

    React.useLayoutEffect(() => {
      document.body.appendChild(container)
      const root = createRoot(container)
      rootRef.current = root
      return () => { root.unmount(); container.remove() }
    }, [container])

    // No dependency list, like drei: the inner root re-renders on every commit.
    React.useLayoutEffect(() => {
      rootRef.current?.render(React.createElement(
        'div',
        {
          'data-testid': 'html',
          'data-pointer': style?.pointerEvents,
          'data-position': position?.join(','),
          style,
        },
        children,
      ))
    })

    return null
  }

  return { Html: HtmlMock }
})

import { DimensionLabel } from '../DimensionLabel'

async function renderLabel(props: Partial<React.ComponentProps<typeof DimensionLabel>> = {}) {
  const utils = render(
    <DimensionLabel
      cid="c1" x={3} y={4} label="R5" color="#ffd54f" isDragged={false}
      {...props}
    />,
  )
  // Let the nested Html root commit, as it does a task after the parent.
  await act(async () => {})
  return utils
}

function labelWrapper(): HTMLElement {
  const wrapper = document.querySelector('[data-testid="html"]') as HTMLElement | null
  expect(wrapper, 'the Html wrapper was never rendered').not.toBeNull()
  return wrapper!
}

function textDiv(): HTMLElement {
  return labelWrapper().querySelector('div') as HTMLElement
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
  it('never takes pointer events, so the canvas listeners keep hearing the pointer', async () => {
    await renderLabel()

    expect(labelWrapper().getAttribute('data-pointer')).toBe('none')
  })

  it('renders the label at the shared z offset', async () => {
    await renderLabel()

    // The text is the label's only visible part; there is no hit mesh to carry
    // the position any more.
    expect(labelWrapper().getAttribute('data-position')).toBe(`3,4,${LABEL_Z_OFFSET}`)
    expect(labelWrapper().textContent).toBe('R5')
  })

  it('keeps userSelect off, so a label drag cannot select text', async () => {
    await renderLabel()

    expect(textDiv().style.userSelect).toBe('none')
  })

  // The label sits under the cursor while a dim is dragged, so an opaque box
  // would hide the vertex the user is aiming at.
  it('has no background fill while dragged', async () => {
    await renderLabel({ isDragged: true })

    expect(textDiv().style.background).toBe('transparent')
  })

  // With no box behind it, the halo is what keeps the digits readable where
  // they cross sketch lines.
  it('draws a text halo in place of the box', async () => {
    await renderLabel()

    expect(textDiv().style.textShadow).toContain('#111')
  })
})

describe('DimensionLabel pick footprint', () => {
  it('publishes the rendered text box, so a click on the far glyphs reaches the label', async () => {
    await renderLabel()
    stubBox(textDiv(), 100, 50)

    // 175 is 75 px from the box centre: far beyond the ring's 8 px reach, and
    // still inside the text the user sees.
    expect(dimensionLabelDomHit(175, 60)).toMatchObject({
      layer: 'dimensionLabel', entityKey: 'dim:c1',
    })
    // Outside the glyph block nothing is claimed.
    expect(dimensionLabelDomHit(99, 60)).toBeNull()
    expect(dimensionLabelDomHit(181, 60)).toBeNull()
  })

  it('publishes nothing without an interaction', async () => {
    await renderLabel({ enabled: false })
    stubBox(textDiv())
    expect(dimensionLabelDomHit(140, 60)).toBeNull()
  })

  it('publishes nothing while the label is dragged', async () => {
    await renderLabel({ isDragged: true })
    stubBox(textDiv(), 200, 50)
    expect(dimensionLabelDomHit(240, 60)).toBeNull()
  })
})
