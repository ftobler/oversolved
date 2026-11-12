import * as THREE from 'three'
import { generateMagicSquareNoise, GTAOShader } from 'three/examples/jsm/shaders/GTAOShader.js'
import {
  generatePdSamplePointInitializer, PoissonDenoiseShader,
} from 'three/examples/jsm/shaders/PoissonDenoiseShader.js'

// Half float render targets need this extension; without it the AO targets fall
// back to bytes instead of failing the frame. A caller with no renderer (tests)
// gets the half-float path, which is what every WebGL2 context in the wild
// supports.
function supportsHalfFloat(gl?: THREE.WebGLRenderer): boolean {
  return gl?.extensions?.has?.('EXT_color_buffer_float') ?? true
}

// The occlusion pipeline, free of React and of the presenter: one G-buffer pass
// the caller feeds the scene into, then two fullscreen draws this module owns.
// Kept in its own file so the targets, the shader inputs and the disposal are
// unit-testable against a stand-in renderer.

// AO is low-frequency light, and the GTAO loop is the most expensive shader in
// the frame, so both output targets are half the drawing buffer. The beauty
// pass samples the result with the texture's linear filter.
const RESOLUTION_DIVISOR = 2

// The radius arrives in view units (aoRadiusFor returns a fraction of the
// model extent). The thickness is the depth shell of a sample and is compared
// against a view-space distance, so it is a ratio of the radius, taken from the
// GTAOPass defaults (radius 0.25, thickness 1). Scaling it keeps a millimetre
// and an inch copy of one part looking alike instead of trading a thin shell for
// a thick one.
const REFERENCE_RADIUS = 0.25
const THICKNESS_AT_REFERENCE = 1

export class AoPass {
  // View normals in colour and depth in the depth texture; the only input the
  // GTAO shader reads from the scene.
  readonly gbuffer: THREE.WebGLRenderTarget
  readonly gtaoTarget: THREE.WebGLRenderTarget
  readonly aoTarget: THREE.WebGLRenderTarget
  readonly noiseTexture: THREE.DataTexture
  readonly normalMaterial: THREE.MeshNormalMaterial
  readonly gtaoMaterial: THREE.ShaderMaterial
  readonly pdMaterial: THREE.ShaderMaterial
  readonly quad: THREE.Mesh
  readonly quadScene: THREE.Scene
  readonly camera: THREE.OrthographicCamera
  private width = 0
  private height = 0

  constructor(gl?: THREE.WebGLRenderer) {
    // Plain depth, one 24-bit stencil/depth texel per pixel. The canvas renders
    // with the logarithmic depth buffer on, but three only applies it to a
    // perspective projection (logdepthbuf_fragment writes gl_FragCoord.z for
    // anything else), and the viewport camera is orthographic. GTAO's
    // orthographic branch can therefore read this texture directly; no
    // linear-depth pass is needed.
    const depthTexture = new THREE.DepthTexture(1, 1)
    depthTexture.format = THREE.DepthStencilFormat
    depthTexture.type = THREE.UnsignedInt248Type
    // Nearest: both shaders fetch exact texels (texelFetch for the depth
    // derivatives), so a filtered G-buffer would smear a crease across it.
    this.gbuffer = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
    })
    // Half float like GTAOPass: an occlusion factor is a smooth 0..1 field, so
    // 8 bits band it into visible stair steps across a large face. Rendering
    // into one needs EXT_color_buffer_float; a context without it falls back to
    // bytes rather than failing every frame.
    const type = supportsHalfFloat(gl) ? THREE.HalfFloatType : THREE.UnsignedByteType
    this.gtaoTarget = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false })
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false })

    this.noiseTexture = generateMagicSquareNoise()

    // DoubleSide: body faces are double sided, and a one-sided normal pass
    // would drop open shells and back-facing walls out of the occluders.
    // NoBlending: the pass replaces the G-buffer, it does not mix into it.
    this.normalMaterial = new THREE.MeshNormalMaterial({
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
    })

    this.gtaoMaterial = new THREE.ShaderMaterial({
      defines: {
        ...GTAOShader.defines,
        PERSPECTIVE_CAMERA: 0,
        NORMAL_VECTOR_TYPE: 1,
        DEPTH_SWIZZLING: 'x',
      },
      uniforms: THREE.UniformsUtils.clone(GTAOShader.uniforms),
      vertexShader: GTAOShader.vertexShader,
      fragmentShader: GTAOShader.fragmentShader,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.gtaoMaterial.uniforms.tNoise.value = this.noiseTexture
    this.gtaoMaterial.uniforms.tNormal.value = this.gbuffer.texture
    this.gtaoMaterial.uniforms.tDepth.value = this.gbuffer.depthTexture

    this.pdMaterial = new THREE.ShaderMaterial({
      defines: {
        ...PoissonDenoiseShader.defines,
        // GTAOPass's own sample disc (16 samples, 2 rings, radius exponent 2);
        // the module default uses exponent 1.
        SAMPLE_VECTORS: generatePdSamplePointInitializer(16, 2, 2),
        NORMAL_VECTOR_TYPE: 1,
        DEPTH_VALUE_SOURCE: 0,
      },
      uniforms: THREE.UniformsUtils.clone(PoissonDenoiseShader.uniforms),
      vertexShader: PoissonDenoiseShader.vertexShader,
      fragmentShader: PoissonDenoiseShader.fragmentShader,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.pdMaterial.uniforms.tDiffuse.value = this.gtaoTarget.texture
    this.pdMaterial.uniforms.tNoise.value = this.noiseTexture
    this.pdMaterial.uniforms.tNormal.value = this.gbuffer.texture
    this.pdMaterial.uniforms.tDepth.value = this.gbuffer.depthTexture
    // The tuned set from GTAOPass: discriminate on depth and normal (a crease
    // must survive the blur), with the shader's looser luma weight widened,
    // because an occlusion value carries no detail worth protecting.
    this.pdMaterial.uniforms.lumaPhi.value = 10
    this.pdMaterial.uniforms.depthPhi.value = 2
    this.pdMaterial.uniforms.normalPhi.value = 3
    // Half resolution, so each disc step covers two screen pixels.
    this.pdMaterial.uniforms.radius.value = 8

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.gtaoMaterial)
    this.quad.frustumCulled = false
    this.quadScene = new THREE.Scene()
    this.quadScene.add(this.quad)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / RESOLUTION_DIVISOR))
    const h = Math.max(1, Math.floor(height / RESOLUTION_DIVISOR))
    if (this.width === w && this.height === h) return
    this.width = w
    this.height = h
    this.gbuffer.setSize(w, h)
    this.gtaoTarget.setSize(w, h)
    this.aoTarget.setSize(w, h)
  }

  /**
   * Copy the live frame's camera into the two shaders and write the radius.
   * The view refits the orthographic frustum on every orbit and zoom, so
   * nothing may be cached at construction: near/far, the projection matrix and
   * its inverse are read here, once per AO frame.
   *
   * Orthographic only, on purpose: the G-buffer's depth is read back through
   * GTAO's orthographic branch (`PERSPECTIVE_CAMERA 0`), which is what the part
   * viewport camera is. A perspective camera here would need the other branch
   * and a linear depth pass, so it is refused by the type rather than silently
   * producing a wrong occlusion.
   */
  update(camera: THREE.OrthographicCamera, radius: number): void {
    const gtao = this.gtaoMaterial.uniforms
    gtao.cameraNear.value = camera.near
    gtao.cameraFar.value = camera.far
    gtao.cameraProjectionMatrix.value.copy(camera.projectionMatrix)
    gtao.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse)
    gtao.cameraWorldMatrix.value.copy(camera.matrixWorld)
    gtao.resolution.value.set(this.width, this.height)
    gtao.radius.value = radius
    gtao.thickness.value = THICKNESS_AT_REFERENCE * (radius / REFERENCE_RADIUS)
    // distanceFallOff stays at GTAO's default 1 and is deliberately NOT scaled
    // with the radius: the shader uses it as the weight of a dimensionless blend
    // (mix(1., 2./float(j+2), distanceFallOff)) per disc step. A value above 1
    // makes that weight negative for every j >= 1, so the horizon accumulator
    // moves the wrong way and sqrt(1 - c*c) goes NaN for a millimetre-scale part
    // (radius 0.03 * extent always exceeds the 0.25 view-unit reference).

    const pd = this.pdMaterial.uniforms
    pd.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse)
    pd.resolution.value.set(this.width, this.height)
  }

  dispose(): void {
    this.gbuffer.dispose()
    // The render target does not own its depth texture; free it explicitly or
    // every AO toggle leaks one.
    this.gbuffer.depthTexture?.dispose()
    this.gtaoTarget.dispose()
    this.aoTarget.dispose()
    this.normalMaterial.dispose()
    this.gtaoMaterial.dispose()
    this.pdMaterial.dispose()
    this.noiseTexture.dispose()
    this.quad.geometry.dispose()
  }
}
