import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import { MsaaRender } from '@/components/Viewport/MsaaRender'
import { MsaaPresenter, presentFrame } from '@/components/Viewport/msaaPresenter'

// MsaaRender's contract with R3F: it claims the frame with a positive useFrame
// priority (which is what stops R3F's own gl.render), draws through a presenter
// it registers for the renderer, and asks for a frame once that presenter
// exists so a demand-mode viewport does not keep a frame drawn without it.

const h = vi.hoisted(() => ({
  frame: null as ((state: { gl: unknown; scene: unknown; camera: unknown }) => void) | null,
  priority: undefined as number | undefined,
  invalidate: vi.fn(),
  gl: null as unknown,
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: (cb: typeof h.frame, priority?: number) => { h.frame = cb; h.priority = priority },
  useThree: (selector: (s: Record<string, unknown>) => unknown) => selector({ gl: h.gl, invalidate: h.invalidate }),
}))

const scene = new THREE.Scene()
const camera = new THREE.OrthographicCamera()

beforeEach(() => {
  h.frame = null
  h.priority = undefined
  h.invalidate.mockClear()
  h.gl = { render: vi.fn() }
})

describe('MsaaRender', () => {
  it('takes over the render with a positive frame priority', () => {
    render(<MsaaRender />)
    expect(h.priority).toBeGreaterThan(0)
  })

  it('draws each frame through its presenter and asks for one once that presenter exists', () => {
    const spy = vi.spyOn(MsaaPresenter.prototype, 'render').mockImplementation(() => {})
    render(<MsaaRender />)

    expect(h.invalidate).toHaveBeenCalledOnce()
    h.frame!({ gl: h.gl, scene, camera })
    expect(spy).toHaveBeenCalledWith(h.gl, scene, camera)
    expect((h.gl as { render: ReturnType<typeof vi.fn> }).render).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('registers the presenter for one-off frames and unhooks and disposes it on unmount', () => {
    const renderSpy = vi.spyOn(MsaaPresenter.prototype, 'render').mockImplementation(() => {})
    const disposeSpy = vi.spyOn(MsaaPresenter.prototype, 'dispose')
    const gl = h.gl as THREE.WebGLRenderer
    const view = render(<MsaaRender />)

    presentFrame(gl, scene, camera)
    expect(renderSpy).toHaveBeenCalledOnce()

    view.unmount()
    expect(disposeSpy).toHaveBeenCalledOnce()
    presentFrame(gl, scene, camera)
    expect(gl.render).toHaveBeenCalledWith(scene, camera)
    renderSpy.mockRestore()
    disposeSpy.mockRestore()
  })
})
