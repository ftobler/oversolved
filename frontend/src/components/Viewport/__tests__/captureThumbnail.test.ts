import { describe, expect, it, vi, afterEach } from 'vitest'
import * as THREE from 'three'
import { captureThumbnail } from '@/components/Viewport/captureThumbnail'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

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
    localClippingEnabled: true,
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

  function stubCanvas(alpha = 255) {
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) })),
    }
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

  it('repaints a full-size frame after restoring, so a demand-mode viewport is not left blank', async () => {
    // The size restore clears the drawing buffer, and the part viewport draws
    // on demand: without this redraw the quarter-size capture would be the last
    // frame drawn and the user would face a blank viewport until the next
    // unrelated change.
    stubImage(320, 200)
    stubCanvas()
    const { gl, render, setSize } = makeFakeGl()

    await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    expect(render).toHaveBeenCalledTimes(2)
    // ...and in that order: the repaint has to land after the size is restored,
    // or the viewport would be left at the quarter-size capture.
    expect(render.mock.invocationCallOrder[1]).toBeGreaterThan(setSize.mock.invocationCallOrder[1])
  })

  it('captures without the section and restores the live clipping state', async () => {
    stubImage(320, 200)
    stubCanvas()
    const { gl, render } = makeFakeGl()
    const clippingSeen: boolean[] = []
    render.mockImplementation(() => {
      clippingSeen.push((gl as unknown as { localClippingEnabled: boolean }).localClippingEnabled)
    })

    await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    // The capture draw ignores object clipping, so a document saved mid-section
    // gets an uncut preview; the full-size repaint puts the live state back.
    expect(clippingSeen).toEqual([false, true])
    expect((gl as unknown as { localClippingEnabled: boolean }).localClippingEnabled).toBe(true)
  })

  it('hides the section plane outline and arrow during the capture', async () => {
    stubImage(320, 200)
    stubCanvas()
    const { gl, render } = makeFakeGl()
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true })
    const capturingSeen: boolean[] = []
    render.mockImplementation(() => {
      capturingSeen.push(useSectionStore.getState().capturing)
    })

    await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)

    // The plain scene geometry has to be gone for the capture draw; the
    // full-size repaint runs after it is restored.
    expect(capturingSeen).toEqual([true, false])
    expect(useSectionStore.getState().capturing).toBe(false)
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })

  it('restores local clipping even when the capture throws', async () => {
    const renderError = new Error('WebGL context lost')
    const { gl } = makeFakeGl({ render: () => { throw renderError } })

    await expect(captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)).rejects.toThrow(renderError)

    expect((gl as unknown as { localClippingEnabled: boolean }).localClippingEnabled).toBe(true)
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

  it('returns null for a frame with no drawn pixels, so an empty view cannot replace a thumbnail', async () => {
    // The viewport clears to alpha 0 and shows its CSS background through the
    // canvas, so "nothing rendered" is a fully transparent image. That is a
    // miss: storing it would swap a real thumbnail for a blank tile.
    stubImage(320, 200)
    const { canvas } = stubCanvas(0)
    const { gl } = makeFakeGl()

    expect(await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)).toBeNull()
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })

  it('finds content after leading transparent pixels', async () => {
    stubImage(320, 200)
    const { ctx } = stubCanvas()
    ctx.getImageData.mockReturnValueOnce({ data: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]) })
    const { gl } = makeFakeGl()

    expect(await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera))
      .toBe('data:image/png;base64,THUMB')
  })

  it('treats a failed pixel read as a miss instead of throwing through the save', async () => {
    stubImage(320, 200)
    const { ctx } = stubCanvas()
    ctx.getImageData.mockImplementationOnce(() => { throw new Error('context lost') })
    const { gl } = makeFakeGl()

    expect(await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)).toBeNull()
  })

  it('returns before resizing a viewport with no laid-out size', async () => {
    const setSize = vi.fn()
    const toDataURL = vi.fn()
    const gl = {
      getSize: (target: THREE.Vector2) => target.set(0, 0),
      setSize,
      render: vi.fn(),
      domElement: { toDataURL },
    } as unknown as THREE.WebGLRenderer

    expect(await captureThumbnail(gl, {} as THREE.Scene, {} as THREE.Camera)).toBeNull()
    expect(setSize).not.toHaveBeenCalled()
    expect(toDataURL).not.toHaveBeenCalled()
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
