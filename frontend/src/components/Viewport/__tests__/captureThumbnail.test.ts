import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { captureThumbnail } from '@/components/Viewport/captureThumbnail'

// A minimal stand-in for THREE.WebGLRenderer: only the surface captureThumbnail
// touches (getSize/setSize/render/domElement.toDataURL). Avoids spinning up a
// real WebGL context in jsdom, which has none.
function makeFakeGl(overrides: Partial<{
  render: () => void
  toDataURL: () => string
}> = {}) {
  const size = new THREE.Vector2(800, 600)
  const setSize = vi.fn((width: number, height: number) => {
    size.set(width, height)
  })
  const render = vi.fn(overrides.render ?? (() => {}))
  const toDataURL = vi.fn(overrides.toDataURL ?? (() => 'data:image/png;base64,AAAA'))
  const gl = {
    getSize: (target: THREE.Vector2) => target.copy(size),
    setSize,
    render,
    domElement: { toDataURL },
  } as unknown as THREE.WebGLRenderer
  return { gl, setSize, render, toDataURL }
}

describe('captureThumbnail', () => {
  it('restores the live renderer size even when gl.render throws', async () => {
    const renderError = new Error('WebGL context lost')
    const { gl, setSize, render } = makeFakeGl({
      render: () => {
        throw renderError
      },
    })
    const scene = {} as THREE.Scene
    const camera = {} as THREE.Camera

    await expect(captureThumbnail(gl, scene, camera)).rejects.toThrow(renderError)

    expect(render).toHaveBeenCalled()
    // Downsized to a quarter for the capture, then restored to the original
    // size the on-screen Viewport was actually using.
    expect(setSize).toHaveBeenNthCalledWith(1, 200, 150)
    expect(setSize).toHaveBeenLastCalledWith(800, 600)
  })

  it('restores the live renderer size even when toDataURL throws', async () => {
    const readError = new Error('failed to read pixels')
    const { gl, setSize, toDataURL } = makeFakeGl({
      toDataURL: () => {
        throw readError
      },
    })
    const scene = {} as THREE.Scene
    const camera = {} as THREE.Camera

    await expect(captureThumbnail(gl, scene, camera)).rejects.toThrow(readError)

    expect(toDataURL).toHaveBeenCalled()
    expect(setSize).toHaveBeenLastCalledWith(800, 600)
  })
})
