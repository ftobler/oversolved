// The AO pass without a GPU: what it allocates, what it feeds the two shaders
// from the live camera, and that everything it owns is freed again. The
// renderer-side wiring (order of the stages) belongs to msaaPresenter.test.ts.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { AoPass } from '@/components/Viewport/aoPass'

function ortho(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.5, 250)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

describe('AoPass', () => {
  it('feeds GTAO from the G-buffer normal colour and depth texture', () => {
    const pass = new AoPass()

    expect(pass.gtaoMaterial).toBeInstanceOf(THREE.ShaderMaterial)
    const uniforms = pass.gtaoMaterial.uniforms
    expect(uniforms.tNormal.value).toBe(pass.gbuffer.texture)
    expect(uniforms.tDepth.value).toBe(pass.gbuffer.depthTexture)
    expect(uniforms.tNoise.value).toBe(pass.noiseTexture)
    // The GTAO quad is the stub-killer: a plain colour quad has no depth input.
    expect(pass.noiseTexture).toBeInstanceOf(THREE.DataTexture)
    expect(pass.noiseTexture.wrapS).toBe(THREE.RepeatWrapping)
  })

  it('denoises the GTAO output against the same normal and depth inputs', () => {
    const pass = new AoPass()
    const uniforms = pass.pdMaterial.uniforms
    expect(uniforms.tDiffuse.value).toBe(pass.gtaoTarget.texture)
    expect(uniforms.tNormal.value).toBe(pass.gbuffer.texture)
    expect(uniforms.tDepth.value).toBe(pass.gbuffer.depthTexture)
    expect(uniforms.tNoise.value).toBe(pass.noiseTexture)
  })

  it('reads the orthographic depth straight out of the G-buffer', () => {
    // The depth texture holds plain ortho depth: the canvas turns on the
    // logarithmic depth buffer, but three writes gl_FragCoord.z for a
    // non-perspective projection. GTAO's orthographic branch therefore needs
    // no linearisation pass.
    const pass = new AoPass()
    const camera = ortho()

    pass.update(camera, 1)

    expect(pass.gtaoMaterial.defines.PERSPECTIVE_CAMERA).toBe(0)
    expect(pass.pdMaterial.defines.NORMAL_VECTOR_TYPE).toBe(1)
    expect(pass.gtaoMaterial.defines.DEPTH_SWIZZLING).toBe('x')
    const inverse = pass.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value as THREE.Matrix4
    expect(inverse.equals(camera.projectionMatrixInverse)).toBe(true)
    const projection = pass.gtaoMaterial.uniforms.cameraProjectionMatrix.value as THREE.Matrix4
    expect(projection.equals(camera.projectionMatrix)).toBe(true)
    expect(pass.gtaoMaterial.uniforms.cameraNear.value).toBe(camera.near)
    expect(pass.gtaoMaterial.uniforms.cameraFar.value).toBe(camera.far)
    expect((pass.pdMaterial.uniforms.cameraProjectionMatrixInverse.value as THREE.Matrix4)
      .equals(camera.projectionMatrixInverse)).toBe(true)
  })

  it('writes the radius and keeps only the depth shell proportional to it', () => {
    // The radius arrives in view units (aoRadiusFor returns a fraction of the
    // model extent), so the thickness is a ratio of it, not an absolute default:
    // an inch copy at 1/25.4 the extent keeps its look. The falloff is NOT a
    // view distance: GTAO uses it as the weight of a dimensionless per-step
    // blend, and anything above 1 makes that weight negative.
    const pass = new AoPass()
    const camera = ortho()

    pass.update(camera, 0.5)
    const uniforms = pass.gtaoMaterial.uniforms
    expect(uniforms.radius.value).toBe(0.5)
    const thickness = uniforms.thickness.value as number
    expect(uniforms.distanceFallOff.value).toBe(1)

    pass.update(camera, 1)
    expect(uniforms.radius.value).toBe(1)
    expect(uniforms.thickness.value).toBeCloseTo(thickness * 2)
    expect(uniforms.distanceFallOff.value).toBe(1)
  })

  it('allocates half-float AO targets, with no depth buffer to keep', () => {
    const pass = new AoPass()

    for (const target of [pass.gtaoTarget, pass.aoTarget]) {
      expect(target.texture.type).toBe(THREE.HalfFloatType)
      expect(target.depthBuffer).toBe(false)
    }
  })

  it('allocates half-resolution targets and only resizes when the size moves', () => {
    const pass = new AoPass()
    const resize = vi.spyOn(pass.gbuffer, 'setSize')

    pass.setSize(1600, 900)
    for (const target of [pass.gbuffer, pass.gtaoTarget, pass.aoTarget]) {
      expect([target.width, target.height]).toEqual([800, 450])
    }

    pass.setSize(1600, 900)
    expect(resize).toHaveBeenCalledTimes(1)

    pass.setSize(800, 450)
    expect(resize).toHaveBeenCalledTimes(2)
    expect([pass.aoTarget.width, pass.aoTarget.height]).toEqual([400, 225])
  })

  it('frees every target, material, noise texture and the quad', () => {
    const pass = new AoPass()
    const owned = [
      pass.gbuffer,
      pass.gbuffer.depthTexture!,
      pass.gtaoTarget,
      pass.aoTarget,
      pass.normalMaterial,
      pass.gtaoMaterial,
      pass.pdMaterial,
      pass.noiseTexture,
      pass.quad.geometry,
    ]
    const spies = owned.map((object) => {
      const spy = vi.fn()
      object.addEventListener('dispose', spy)
      return spy
    })

    pass.dispose()

    for (const spy of spies) expect(spy).toHaveBeenCalledOnce()
  })
})
