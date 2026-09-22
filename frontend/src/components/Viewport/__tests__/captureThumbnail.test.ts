import { describe, expect, it, vi, afterEach } from 'vitest'
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

  // jsdom has neither image decoding nor a 2D canvas context, so the load and
  // the downscale are exercised with stand-ins. The MAX_SIZE cap is a storage
  // invariant: an unbounded screenshot would bloat every saved document.
  function stubImage(width: number, height: number) {
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = width
      height = height
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)
  }

  function stubCanvas() {
    const ctx = { drawImage: vi.fn() }
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toDataURL: vi.fn(() => 'data:image/png;base64,THUMB'),
    }
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? (canvas as unknown as HTMLElement) : original(tag))
    return { canvas, ctx }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('scales an oversized capture down so the longest side is capped at MAX_SIZE', async () => {
    stubImage(4096, 2048)
    const { canvas, ctx } = stubCanvas()
    const { gl } = makeFakeGl()

    const result = await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    expect(result).toBe('data:image/png;base64,THUMB')
    expect(canvas.width).toBe(1024)
    expect(canvas.height).toBe(512)
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1024, 512)
  })

  it('never upscales a capture smaller than MAX_SIZE', async () => {
    stubImage(320, 200)
    const { canvas } = stubCanvas()
    const { gl } = makeFakeGl()

    await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    expect(canvas.width).toBe(320)
    expect(canvas.height).toBe(200)
  })

  it('returns null when the downscale canvas has no 2D context', async () => {
    // Some environments (a headless/no-accelerated canvas, an exhausted context
    // budget) refuse a 2D context; a save must skip the preview, not throw.
    stubImage(640, 480)
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => null), toDataURL: vi.fn() }
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? (canvas as unknown as HTMLElement) : original(tag))
    const { gl } = makeFakeGl()

    const result = await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    expect(result).toBeNull()
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })

  it('returns null when the renderer, scene or camera is not ready', async () => {
    // The headless editor mount: no GL context, so a save must skip the preview
    // rather than throw through the save path.
    expect(await captureThumbnail(null, {} as THREE.Scene, {} as THREE.Camera)).toBeNull()
    expect(await captureThumbnail({} as THREE.WebGLRenderer, null, {} as THREE.Camera)).toBeNull()
    expect(await captureThumbnail({} as THREE.WebGLRenderer, {} as THREE.Scene, null)).toBeNull()
  })

  it('rejects when the captured image cannot be decoded', async () => {
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 1
      height = 1
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const { gl } = makeFakeGl()

    await expect(captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera))
      .rejects.toThrow('Failed to load image')
  })
})
