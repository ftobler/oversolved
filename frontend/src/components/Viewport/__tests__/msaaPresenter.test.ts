import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  MsaaPresenter, PRESENT_SAMPLES, PREMULTIPLIED_OUTPUT_FRAGMENT, attachPresenter, detachPresenter, presentFrame,
} from '@/components/Viewport/msaaPresenter'
import { AO_OCCLUDER_LAYER, aoUniforms, setAoCapturing } from '@/components/Viewport/ambientOcclusion'

// The presenter's contract against a stand-in renderer (jsdom has no WebGL):
// the scene goes into a multisampled target sized to the drawing buffer, and
// the only thing drawn to the canvas is the full-screen output pass reading
// that target. That ordering is the fix: the browser is handed a resolved,
// single-sampled image and has no multisampled canvas to resolve on present.
//
// The fake also records the renderer state each draw sees (bound target, the
// scene's override material and background, clear colour and autoClear), which
// is how the AO stage's save/restore is pinned without a GPU.

interface RenderCall {
  target: THREE.WebGLRenderTarget | null
  object: THREE.Object3D
  camera: THREE.Camera | undefined
  override: THREE.Material | null
  background: THREE.Scene['background']
  // A quad scene is drawn dressed in the material of its only child, and the
  // quad is re-dressed for every AO stage, so record what was on it.
  quadMaterial: THREE.Material | null
  clearColor: number
  clearAlpha: number
  autoClear: boolean
}

function makeFakeGl(opts: { floatColor?: boolean } = {}) {
  const buffer = new THREE.Vector2(1600, 900)
  let current: THREE.WebGLRenderTarget | null = null
  let autoClear = true
  const calls: RenderCall[] = []
  const clearColor = new THREE.Color(0x000000)
  let clearAlpha = 0
  const gl = {
    getDrawingBufferSize: (v: THREE.Vector2) => v.copy(buffer),
    getRenderTarget: () => current,
    setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) => { current = t }),
    get autoClear() { return autoClear },
    set autoClear(value: boolean) { autoClear = value },
    render: vi.fn((object: THREE.Object3D, camera?: THREE.Camera) => {
      const scene = object as THREE.Scene
      const quad = object instanceof THREE.Scene ? object.children[0] as THREE.Mesh | undefined : undefined
      calls.push({
        target: current,
        object,
        camera,
        override: 'overrideMaterial' in scene ? scene.overrideMaterial : null,
        background: 'background' in scene ? scene.background : null,
        quadMaterial: quad ? (quad.material as THREE.Material) : null,
        clearColor: clearColor.getHex(),
        clearAlpha,
        autoClear,
      })
    }),
    getClearColor: (target: THREE.Color) => target.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor: vi.fn((color: THREE.ColorRepresentation, alpha?: number) => {
      clearColor.set(color)
      if (alpha !== undefined) clearAlpha = alpha
    }),
    setClearAlpha: vi.fn((alpha: number) => { clearAlpha = alpha }),
    clear: vi.fn(),
    extensions: { has: (name: string) => name === 'EXT_color_buffer_float' && (opts.floatColor ?? true) },
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
  } as unknown as THREE.WebGLRenderer
  return {
    gl,
    buffer,
    calls,
    clearColor,
    getClearAlpha: () => clearAlpha,
    setCurrent: (t: THREE.WebGLRenderTarget | null) => { current = t },
  }
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

    expect(calls).toEqual([expect.objectContaining({ target: null, object: scene })])
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

// The AO stage is three offscreen draws before the beauty pass. The gate is the
// caller's resolved flag (MsaaRender), so the presenter only has to keep the
// order, the scene state and the shared uniforms right.
describe('MsaaPresenter ambient occlusion', () => {
  beforeEach(() => {
    aoUniforms.tAO.value = null
    aoUniforms.uResolution.value.set(1, 1)
    setAoCapturing(false)
  })

  function aoPresenter(extent = 25.4): MsaaPresenter {
    const presenter = new MsaaPresenter()
    presenter.aoActive = true
    presenter.modelExtent = extent
    return presenter
  }

  it('allocates nothing and keeps the pre-AO call list while the option is off', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = new MsaaPresenter()
    presenter.aoActive = false

    presenter.render(gl, scene, camera)

    expect(presenter.aoPass).toBeNull()
    expect(aoUniforms.tAO.value).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[0].object).toBe(scene)
    expect(calls[1].target).toBeNull()
  })

  it('draws normals and depth first, then GTAO, then the denoise, then the scene', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = aoPresenter()

    presenter.render(gl, scene, camera)

    const pass = presenter.aoPass!
    expect(calls).toHaveLength(5)

    // The pre-pass is the only draw that sees the scene: opaque faces on the
    // occluder layer, through the normal override, on a blue background.
    const gbuffer = calls[0]
    expect(gbuffer.target).toBe(pass.gbuffer)
    expect(gbuffer.camera).not.toBe(camera)
    expect(gbuffer.camera!.layers.mask).toBe(1 << AO_OCCLUDER_LAYER)
    expect(gbuffer.override).toBe(pass.normalMaterial)
    expect(gbuffer.background).toBeNull()
    expect(gbuffer.clearColor).toBe(0x7777ff)

    const gtao = calls[1]
    expect(gtao.target).toBe(pass.gtaoTarget)
    expect(gtao.object).toBe(pass.quadScene)
    expect(gtao.quadMaterial).toBe(pass.gtaoMaterial)

    const denoise = calls[2]
    expect(denoise.target).toBe(pass.aoTarget)
    expect(denoise.quadMaterial).toBe(pass.pdMaterial)
    // The denoiser discards background pixels, so the fringe of every body
    // would sample whatever the target held before: white, every frame.
    expect(denoise.clearColor).toBe(0xffffff)
    expect(gl.clear).toHaveBeenCalledTimes(3)

    // The beauty pass runs with the override off again.
    expect(calls[3].object).toBe(scene)
    expect(calls[3].override).toBeNull()
    expect(calls[3].target!.samples).toBe(PRESENT_SAMPLES)

    expect(calls[4].target).toBeNull()
    expect(calls[4].object).not.toBe(scene)
  })

  it('puts the scene, clear colour, clear alpha and autoClear back after the stage', () => {
    const { gl, calls, clearColor, getClearAlpha } = makeFakeGl()
    const ownScene = new THREE.Scene()
    const background = new THREE.Color('#123456')
    ownScene.background = background
    const override = new THREE.MeshBasicMaterial()
    ownScene.overrideMaterial = override
    gl.autoClear = false
    gl.setClearColor(0xabcdef, 0.5)

    aoPresenter().render(gl, ownScene, camera)

    expect(ownScene.overrideMaterial).toBe(override)
    // The override is restored rather than nulled, and the beauty pass draws
    // with whatever state the caller had, exactly as it would without AO.
    expect(calls[3].override).toBe(override)
    expect(ownScene.background).toBe(background)
    expect(calls[3].background).toBe(background)
    expect(gl.getClearColor(new THREE.Color()).getHex()).toBe(0xabcdef)
    expect(getClearAlpha()).toBe(0.5)
    expect(clearColor.getHex()).toBe(0xabcdef)
    expect(gl.autoClear).toBe(false)
  })

  it('hands the body material the denoised texture and the drawing-buffer size', () => {
    const { gl } = makeFakeGl()
    const presenter = aoPresenter()

    presenter.render(gl, scene, camera)

    expect(aoUniforms.tAO.value).toBe(presenter.aoPass!.aoTarget.texture)
    expect(aoUniforms.uResolution.value.toArray()).toEqual([1600, 900])
  })

  it('measures the radius in view units, so mm and inch copies of a part agree', () => {
    const mm = aoPresenter(25.4)
    const inch = aoPresenter(1)
    const mmGl = makeFakeGl()
    const inchGl = makeFakeGl()

    mm.render(mmGl.gl, scene, camera)
    inch.render(inchGl.gl, scene, camera)

    const mmRadius = mm.aoPass!.gtaoMaterial.uniforms.radius.value as number
    const inchRadius = inch.aoPass!.gtaoMaterial.uniforms.radius.value as number
    expect(mmRadius / inchRadius).toBeCloseTo(25.4)
    const mmThickness = mm.aoPass!.gtaoMaterial.uniforms.thickness.value as number
    const inchThickness = inch.aoPass!.gtaoMaterial.uniforms.thickness.value as number
    expect(mmThickness / inchThickness).toBeCloseTo(25.4)
  })

  it('reuses one pre-pass camera instead of cloning the camera every frame', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = aoPresenter()

    presenter.render(gl, scene, camera)
    presenter.render(gl, scene, camera)

    expect(calls[0].camera).toBe(calls[5].camera)
  })

  it('frees the AO pass when the option turns off and again on dispose', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = aoPresenter()
    presenter.render(gl, scene, camera)
    const pass = presenter.aoPass!
    const disposed = vi.fn()
    pass.aoTarget.addEventListener('dispose', disposed)

    presenter.aoActive = false
    presenter.render(gl, scene, camera)

    expect(disposed).toHaveBeenCalledOnce()
    expect(presenter.aoPass).toBeNull()
    expect(aoUniforms.tAO.value).toBeNull()
    expect(calls).toHaveLength(7)

    presenter.aoActive = true
    presenter.render(gl, scene, camera)
    const rebuilt = vi.fn()
    presenter.aoPass!.gbuffer.addEventListener('dispose', rebuilt)
    presenter.dispose()
    expect(rebuilt).toHaveBeenCalledOnce()
    expect(presenter.aoPass).toBeNull()
    expect(aoUniforms.tAO.value).toBeNull()
  })

  it('skips the AO stage for a capture frame', () => {
    const { gl, calls } = makeFakeGl()
    const presenter = aoPresenter()

    setAoCapturing(true)
    presenter.render(gl, scene, camera)

    expect(calls).toHaveLength(2)
    expect(presenter.aoPass).toBeNull()
  })
})
