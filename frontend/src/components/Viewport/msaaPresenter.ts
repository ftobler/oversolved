import * as THREE from 'three'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { AoPass } from '@/components/Viewport/aoPass'
import {
  AO_OCCLUDER_LAYER, aoFallbackTexture, aoRadiusFor, aoUniforms, isAoCapturing,
} from '@/components/Viewport/ambientOcclusion'
import { useSectionStore } from '@/stores/sectionStore'

// Multisampling the part viewport ourselves instead of asking the browser for an
// antialiased canvas. With `antialias: true` the default framebuffer is
// multisampled and the browser resolves it on every present; on some
// GPU/compositor paths (seen on NVIDIA under Wayland, Chrome) that present-time
// resolve shimmers the edge samples of fine 1px lines although a readback of the
// same frame is pixel-identical every time. Resolving into our own target and
// handing the canvas a plain, single-sampled image leaves the browser nothing to
// resolve, so what it presents is exactly what we drew.
export const PRESENT_SAMPLES = 4

// OutputPass's own shader tone-maps and encodes the texel as it finds it. The
// target is cleared transparent and the canvas shows the CSS background
// through, so a partly covered pixel (a line's antialiased fringe, a
// translucent plane over empty space) holds premultiplied colour c*a. Encoding
// that gives OETF(ACES(c*a)), brighter than the OETF(ACES(c))*a a premultiplied
// canvas expects, which reads as a bright fringe on exactly the fine lines this
// path exists for. So: divide the coverage out, tone-map and encode the colour,
// multiply it back in. The tone-mapping chain mirrors OutputShader's, whose
// defines OutputPass keeps setting from the renderer.
export const PREMULTIPLIED_OUTPUT_FRAGMENT = `
  precision highp float;

  uniform sampler2D tDiffuse;

  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>

  varying vec2 vUv;

  void main() {
    vec4 texel = texture2D( tDiffuse, vUv );
    vec3 color = texel.a > 0.0 ? texel.rgb / texel.a : vec3( 0.0 );

    #ifdef LINEAR_TONE_MAPPING
      color = LinearToneMapping( color );
    #elif defined( REINHARD_TONE_MAPPING )
      color = ReinhardToneMapping( color );
    #elif defined( CINEON_TONE_MAPPING )
      color = CineonToneMapping( color );
    #elif defined( ACES_FILMIC_TONE_MAPPING )
      color = ACESFilmicToneMapping( color );
    #elif defined( AGX_TONE_MAPPING )
      color = AgXToneMapping( color );
    #elif defined( NEUTRAL_TONE_MAPPING )
      color = NeutralToneMapping( color );
    #elif defined( CUSTOM_TONE_MAPPING )
      color = CustomToneMapping( color );
    #endif

    #ifdef SRGB_TRANSFER
      color = sRGBTransferOETF( vec4( color, 1.0 ) ).rgb;
    #endif

    gl_FragColor = vec4( color * texel.a, texel.a );
  }
`

/**
 * Renders a scene into a multisampled offscreen target sized to the drawing
 * buffer, then draws the resolved image to the canvas through three's
 * OutputPass. Rendering into a target makes three skip tone mapping and the
 * output colour space for the scene's materials; the output pass applies the
 * renderer's own (R3F's ACES + sRGB) on the way to the screen. Fully covered
 * opaque pixels come out as a direct `gl.render` would draw them. Blending and
 * the sample resolve now happen in linear space, before tone mapping, so an
 * antialiased edge or a translucent overlay is weighted in linear light rather
 * than in encoded sRGB as before: the standard three post-processing result,
 * accepted over keeping the old weighting through three's internal XR-target
 * flag.
 */
export class MsaaPresenter {
  private target: THREE.WebGLRenderTarget | null = null
  private readonly output = new OutputPass()
  private readonly size = new THREE.Vector2()
  private readonly samples: number
  private stencil = false
  // One camera for every G-buffer pass, layer-masked to the occluders and
  // refilled from the live camera each frame: a per-frame clone would allocate
  // once per frame and the mask would have to be re-applied anyway.
  private readonly prepassCamera = new THREE.OrthographicCamera()
  private readonly clearColor = new THREE.Color()
  // Public so the render harness can see the AO resources exist, are reused
  // and are freed; the presenter itself is the only other owner.
  aoPass: AoPass | null = null
  // Viewer state, fed by MsaaRender or a direct caller.
  // Whether the AO option is on at all. Distinct from `aoActive`: the option
  // being on but the surface shaded some other way (section, capture) keeps the
  // pass allocated, because freeing and rebuilding it is two shader compiles and
  // three targets per frame and a visible hitch on the next save.
  aoEnabled = false
  aoActive = false
  capturing = false
  modelExtent = 0

  constructor(samples: number = PRESENT_SAMPLES) {
    this.samples = samples
    this.output.renderToScreen = true
    this.output.material.fragmentShader = PREMULTIPLIED_OUTPUT_FRAGMENT
  }

  /**
   * Re-create the multisampled target with or without a stencil attachment.
   * WebGL fixes the attachment set when a framebuffer is allocated, so the
   * section's cap passes need a fresh target; the old one is disposed here so
   * a toggle cannot leak a multisampled colour/depth set.
   */
  setStencil(enabled: boolean): void {
    if (this.stencil === enabled) return
    this.stencil = enabled
    this.target?.dispose()
    this.target = null
  }

  hasStencil(): boolean {
    return this.stencil
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const { x, y } = gl.getDrawingBufferSize(this.size)
    const capturing = this.capturing || isAoCapturing() || useSectionStore.getState().capturing
    const target = this.targetFor(gl, x, y)
    const previous = gl.getRenderTarget()

    if (this.aoActive && !capturing) {
      this.renderAo(gl, scene, camera, x, y)
    } else {
      // No result this frame: publish the white texel, never null, because the
      // body material samples tAO whether or not the stage ran. The pass itself
      // is only freed once the option goes off; a capture or a section merely
      // skips the stage, and rebuilding it costs two shader compiles.
      aoUniforms.tAO.value = aoFallbackTexture
      if (!this.aoEnabled) this.releaseAoPass()
    }

    gl.setRenderTarget(target)
    gl.render(scene, camera)
    // renderToScreen ignores the write buffer (and the delta/mask arguments);
    // the target only fills the slot the Pass signature types as required.
    this.output.render(gl, target, target, 0, false)
    gl.setRenderTarget(previous)
  }

  /**
   * The AO stage: the G-buffer, then GTAO into its own target, then the
   * denoiser. Every step runs before the beauty pass, which only reads the
   * shared uniforms this stage writes.
   */
  private renderAo(
    gl: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
  ): void {
    const pass = this.aoPass ?? (this.aoPass = new AoPass(gl))
    pass.setSize(width, height)
    pass.update(camera as THREE.OrthographicCamera, aoRadiusFor(this.modelExtent))

    // The G-buffer borrows the scene, so save exactly what this stage changes
    // and hand the beauty pass the same scene it would have drawn without AO.
    const previousOverride = scene.overrideMaterial
    const previousBackground = scene.background
    gl.getClearColor(this.clearColor)
    const previousClearAlpha = gl.getClearAlpha()
    const previousAutoClear = gl.autoClear

    // The viewport camera is orthographic, so one ortho instance can carry its
    // state frame after frame; the projection itself is copied, not rebuilt.
    this.prepassCamera.copy(camera as THREE.OrthographicCamera)
    // The mask is the occluder bit alone: edges, overlays and transparent
    // bodies are not occluders and must not enter the depth or normal target.
    this.prepassCamera.layers.set(AO_OCCLUDER_LAYER)
    scene.overrideMaterial = pass.normalMaterial
    scene.background = null
    gl.autoClear = false
    gl.setRenderTarget(pass.gbuffer)
    // Anything the occluders do not cover is background: a normal pointing at
    // the camera with full depth, which GTAO and the denoiser both discard.
    gl.setClearColor(0x7777ff, 1)
    gl.clear()
    gl.render(scene, this.prepassCamera)

    scene.overrideMaterial = previousOverride
    scene.background = previousBackground
    this.renderQuad(gl, pass.gtaoMaterial, pass.gtaoTarget)
    this.renderQuad(gl, pass.pdMaterial, pass.aoTarget)

    gl.autoClear = previousAutoClear
    gl.setClearColor(this.clearColor, previousClearAlpha)
    aoUniforms.tAO.value = pass.aoTarget.texture
    aoUniforms.uResolution.value.set(width, height)
  }

  private renderQuad(gl: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget): void {
    const pass = this.aoPass!
    pass.quad.material = material
    gl.setRenderTarget(target)
    // White, every frame: the denoiser discards background pixels, so the
    // silhouette fringe of each body would otherwise keep sampling whatever
    // the target held before (including the previous frame's occlusion).
    gl.setClearColor(0xffffff, 1)
    gl.clear()
    gl.render(pass.quadScene, pass.camera)
  }

  // Sized per call rather than on a resize event: the thumbnail capture shrinks
  // the renderer for one frame, and a stale full-size target would be resolved
  // into the corner of the small canvas.
  private targetFor(gl: THREE.WebGLRenderer, width: number, height: number): THREE.WebGLRenderTarget {
    if (!this.target) {
      // Half float keeps the linear HDR range the tone mapper expects; an 8-bit
      // linear target bands in the shadows. The fallback only applies where
      // float colour attachments are not renderable.
      const type = gl.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType
      this.target = new THREE.WebGLRenderTarget(width, height, {
        samples: this.samples,
        type,
        depthBuffer: true,
        stencilBuffer: this.stencil,
      })
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height)
    }
    return this.target
  }

  dispose(): void {
    this.target?.dispose()
    this.target = null
    this.releaseAoPass()
    this.output.dispose()
  }

  // Free the AO pass and republish the white texel the materials expect.
  private releaseAoPass(): void {
    if (!this.aoPass) return
    this.aoPass.dispose()
    this.aoPass = null
    aoUniforms.tAO.value = aoFallbackTexture
  }
}

// The presenter a renderer currently draws through, so a one-off frame drawn
// outside the R3F loop (the save thumbnail) goes through the same path as the
// on-screen ones instead of an aliased direct render.
const presenters = new WeakMap<THREE.WebGLRenderer, MsaaPresenter>()

export function attachPresenter(gl: THREE.WebGLRenderer, presenter: MsaaPresenter): void {
  presenters.set(gl, presenter)
}

export function detachPresenter(gl: THREE.WebGLRenderer, presenter: MsaaPresenter): void {
  if (presenters.get(gl) === presenter) presenters.delete(gl)
}

/** Draw one frame the way the renderer's viewport does: through its presenter if it has one. */
export function presentFrame(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  const presenter = presenters.get(gl)
  if (presenter) presenter.render(gl, scene, camera)
  else gl.render(scene, camera)
}
