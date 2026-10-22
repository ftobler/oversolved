import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  MsaaPresenter, PRESENT_SAMPLES, PREMULTIPLIED_OUTPUT_FRAGMENT, attachPresenter, detachPresenter, presentFrame,
} from '@/components/Viewport/msaaPresenter'

// The presenter's contract against a stand-in renderer (jsdom has no WebGL):
// the scene goes into a multisampled target sized to the drawing buffer, and
// the only thing drawn to the canvas is the full-screen output pass reading
// that target. That ordering is the fix: the browser is handed a resolved,
// single-sampled image and has no multisampled canvas to resolve on present.

interface RenderCall { target: THREE.WebGLRenderTarget | null; object: THREE.Object3D }

function makeFakeGl(opts: { floatColor?: boolean } = {}) {
  const buffer = new THREE.Vector2(1600, 900)
  let current: THREE.WebGLRenderTarget | null = null
  const calls: RenderCall[] = []
  const gl = {
    getDrawingBufferSize: (v: THREE.Vector2) => v.copy(buffer),
    getRenderTarget: () => current,
    setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) => { current = t }),
    render: vi.fn((object: THREE.Object3D) => { calls.push({ target: current, object }) }),
    extensions: { has: (name: string) => name === 'EXT_color_buffer_float' && (opts.floatColor ?? true) },
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
  } as unknown as THREE.WebGLRenderer
  return { gl, buffer, calls, setCurrent: (t: THREE.WebGLRenderTarget | null) => { current = t } }
}

const scene = new THREE.Scene()
const camera = new THREE.OrthographicCamera()

describe('MsaaPresenter', () => {
  it('renders the scene into a multisampled target, then only the output pass to the canvas', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()

    presenter.render(gl, scene, camera)

    expect(calls).toHaveLength(2)
    const [sceneCall, outputCall] = calls
    expect(sceneCall.object).toBe(scene)
    expect(sceneCall.target).not.toBeNull()
    expect(sceneCall.target!.samples).toBe(PRESENT_SAMPLES)
    expect([sceneCall.target!.width, sceneCall.target!.height]).toEqual([1600, 900])
    // The canvas only ever receives the full-screen quad, never the scene.
    expect(outputCall.target).toBeNull()
    expect(outputCall.object).not.toBe(scene)
    const material = (outputCall.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(material.uniforms.tDiffuse.value).toBe(sceneCall.target!.texture)
  })

  it('tone-maps and sRGB-encodes in the output pass, as a direct render to the canvas would', () => {
    const { gl, calls } = makeFakeGl()
    new MsaaPresenter().render(gl, scene, camera)

    const material = (calls[1].object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(material.defines).toHaveProperty('ACES_FILMIC_TONE_MAPPING')
    expect(material.defines).toHaveProperty('SRGB_TRANSFER')
  })

  it('divides the coverage out before tone mapping and multiplies it back after encoding', () => {
    // The target is cleared transparent, so a line's antialiased fringe holds
    // premultiplied colour; tone-mapping that directly brightens the fringe.
    const { gl, calls } = makeFakeGl()
    new MsaaPresenter().render(gl, scene, camera)

    const shader = ((calls[1].object as THREE.Mesh).material as THREE.ShaderMaterial).fragmentShader
    expect(shader).toBe(PREMULTIPLIED_OUTPUT_FRAGMENT)
    const unpremultiply = shader.indexOf('texel.rgb / texel.a')
    const toneMap = shader.indexOf('ACESFilmicToneMapping( color )')
    const encode = shader.indexOf('sRGBTransferOETF')
    const premultiply = shader.indexOf('color * texel.a')
    expect(unpremultiply).toBeGreaterThan(-1)
    expect(unpremultiply).toBeLessThan(toneMap)
    expect(toneMap).toBeLessThan(encode)
    expect(encode).toBeLessThan(premultiply)
  })

  it('keeps the linear HDR range in half float, falling back to 8-bit where float targets do not render', () => {
    const float = makeFakeGl({ floatColor: true })
    new MsaaPresenter().render(float.gl, scene, camera)
    expect(float.calls[0].target!.texture.type).toBe(THREE.HalfFloatType)

    const bytes = makeFakeGl({ floatColor: false })
    new MsaaPresenter().render(bytes.gl, scene, camera)
    expect(bytes.calls[0].target!.texture.type).toBe(THREE.UnsignedByteType)
  })

  it('reuses its target across frames and follows a drawing-buffer resize', () => {
    const { gl, buffer, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()

    presenter.render(gl, scene, camera)
    presenter.render(gl, scene, camera)
    expect(calls[2].target).toBe(calls[0].target)

    // The thumbnail capture shrinks the renderer for one frame: a stale
    // full-size target would resolve into a corner of the small canvas.
    buffer.set(400, 225)
    presenter.render(gl, scene, camera)
    expect(calls[4].target).toBe(calls[0].target)
    expect([calls[4].target!.width, calls[4].target!.height]).toEqual([400, 225])
  })

  it('swaps in a stencil target for the section cap, disposing the old one', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()
    presenter.render(gl, scene, camera)
    const withoutStencil = calls[0].target!
    expect(withoutStencil.stencilBuffer).toBe(false)
    const disposed = vi.fn()
    withoutStencil.addEventListener('dispose', disposed)

    presenter.setStencil(true)
    expect(presenter.hasStencil()).toBe(true)
    expect(disposed).toHaveBeenCalledOnce()

    presenter.render(gl, scene, camera)
    const withStencil = calls[calls.length - 2].target!
    expect(withStencil).not.toBe(withoutStencil)
    expect(withStencil.stencilBuffer).toBe(true)

    presenter.setStencil(false)
    presenter.render(gl, scene, camera)
    expect(calls[calls.length - 2].target!.stencilBuffer).toBe(false)
  })

  it('restores the render target that was bound before the frame', () => {
    const { gl, setCurrent } = makeFakeGl()
    const outer = new THREE.WebGLRenderTarget(8, 8)
    setCurrent(outer)

    new MsaaPresenter().render(gl, scene, camera)

    expect(gl.getRenderTarget()).toBe(outer)
  })

  it('builds a fresh target after dispose instead of drawing into a freed one', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()
    presenter.render(gl, scene, camera)
    const first = calls[0].target!
    const disposed = vi.fn()
    first.addEventListener('dispose', disposed)

    presenter.dispose()
    presenter.render(gl, scene, camera)

    expect(disposed).toHaveBeenCalledOnce()
    expect(calls[2].target).not.toBe(first)
  })
})

describe('presentFrame', () => {
  it('draws through the presenter attached to the renderer', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()
    attachPresenter(gl, presenter)

    presentFrame(gl, scene, camera)

    expect(calls).toHaveLength(2)
    expect(calls[0].target!.samples).toBe(PRESENT_SAMPLES)
    detachPresenter(gl, presenter)
  })

  it('renders directly for a renderer without one (the assembly viewport)', () => {
    const { gl, calls } = makeFakeGl()

    presentFrame(gl, scene, camera)

    expect(calls).toEqual([{ target: null, object: scene }])
  })

  it('ignores a stale detach from a presenter that was already replaced', () => {
    // StrictMode's remount attaches the second presenter before the first
    // one's cleanup could ever run late; a late detach must not unhook it.
    const { gl, calls } = makeFakeGl()
    const first = new MsaaPresenter()
    const second = new MsaaPresenter()
    attachPresenter(gl, first)
    attachPresenter(gl, second)
    detachPresenter(gl, first)

    presentFrame(gl, scene, camera)

    expect(calls).toHaveLength(2)
    detachPresenter(gl, second)
  })
})
