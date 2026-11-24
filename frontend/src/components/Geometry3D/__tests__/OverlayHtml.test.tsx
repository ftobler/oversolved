import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { Object3D, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three'

type CalculatePosition = (el: Object3D, camera: OrthographicCamera | PerspectiveCamera, size: { width: number; height: number }) => number[]

const captured: {
  onOcclude?: (hidden: boolean) => void
  calculatePosition?: CalculatePosition
} = {}

vi.mock('@react-three/drei', () => ({
  Html: ({ children, style, onOcclude, calculatePosition }: {
    children: React.ReactNode
    style?: React.CSSProperties
    onOcclude?: (hidden: boolean) => void
    calculatePosition?: CalculatePosition
  }) => {
    captured.onOcclude = onOcclude
    captured.calculatePosition = calculatePosition
    return <div data-testid="html" style={style}>{children}</div>
  },
}))

import { OverlayHtml, overlayAnchorVisible } from '../OverlayHtml'

function orthoCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-10, 10, 10, -10, -500, 500)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  return camera
}

function perspectiveCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  return camera
}

beforeEach(() => {
  captured.onOcclude = undefined
  captured.calculatePosition = undefined
})

describe('overlayAnchorVisible', () => {
  it('keeps an orthographic anchor beside and behind the camera position visible', () => {
    // The angle from the view direction is past 90 degrees, so drei hides it.
    // The clip volume is symmetric around the camera plane, so the label must
    // stay: this is the dimension-label bug.
    expect(overlayAnchorVisible(orthoCamera(), new Vector3(500, 0, 11))).toBe(true)
  })

  it('hides an orthographic anchor beyond the far plane', () => {
    expect(overlayAnchorVisible(orthoCamera(), new Vector3(0, 0, -600))).toBe(false)
  })

  it('hides an orthographic anchor beyond the negative near plane', () => {
    expect(overlayAnchorVisible(orthoCamera(), new Vector3(0, 0, 600))).toBe(false)
  })

  it('hides a perspective anchor behind the camera', () => {
    expect(overlayAnchorVisible(perspectiveCamera(), new Vector3(0, 0, 20))).toBe(false)
  })

  it('keeps a perspective anchor in front of the camera visible', () => {
    expect(overlayAnchorVisible(perspectiveCamera(), new Vector3(0, 0, 5))).toBe(true)
  })
})

describe('OverlayHtml', () => {
  it('passes the caller props through and takes over occlusion from drei', () => {
    render(
      <OverlayHtml position={[1, 2, 3]} center style={{ pointerEvents: 'none' }}>
        <span>value</span>
      </OverlayHtml>,
    )

    // onOcclude is what stops drei writing display with its perspective-only
    // rule; the wrapper owns visibility from then on.
    expect(captured.onOcclude).toBeTypeOf('function')
    expect(captured.calculatePosition).toBeTypeOf('function')
    const html = document.querySelector('[data-testid="html"]') as HTMLElement
    expect(html.textContent).toBe('value')
    expect(html.style.pointerEvents).toBe('none')
    expect(html.style.display).not.toBe('none')
  })

  it('hides the overlay when the anchor projects outside the orthographic clip volume', () => {
    render(<OverlayHtml><span>value</span></OverlayHtml>)
    const anchor = new Object3D()
    anchor.position.set(0, 0, -600)
    anchor.updateMatrixWorld()

    act(() => {
      const position = captured.calculatePosition!(anchor, orthoCamera(), { width: 800, height: 600 })
      expect(position[0]).toBeCloseTo(400)
      expect(position[1]).toBeCloseTo(300)
    })

    const html = document.querySelector('[data-testid="html"]') as HTMLElement
    expect(html.style.display).toBe('none')
  })

  it('keeps an orthographic anchor behind the camera position visible', () => {
    render(<OverlayHtml><span>value</span></OverlayHtml>)
    const anchor = new Object3D()
    anchor.position.set(500, 0, 11)
    anchor.updateMatrixWorld()

    act(() => {
      // drei would report this anchor as hidden; the wrapper must not let that
      // perspective-only verdict reach the DOM overlay.
      captured.onOcclude!(true)
      captured.calculatePosition!(anchor, orthoCamera(), { width: 800, height: 600 })
    })

    const html = document.querySelector('[data-testid="html"]') as HTMLElement
    expect(html.style.display).not.toBe('none')
  })

  it('hides a perspective anchor behind the camera', () => {
    render(<OverlayHtml><span>value</span></OverlayHtml>)
    const anchor = new Object3D()
    anchor.position.set(0, 0, 20)
    anchor.updateMatrixWorld()

    act(() => {
      captured.calculatePosition!(anchor, perspectiveCamera(), { width: 800, height: 600 })
    })

    const html = document.querySelector('[data-testid="html"]') as HTMLElement
    expect(html.style.display).toBe('none')
  })
})
