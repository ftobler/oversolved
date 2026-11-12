import * as THREE from 'three'

// Dedicated three Layers bit for bodies that act as AO occluders: opaque faces
// only. The pre-pass camera's layer mask is this bit, so transparent or
// transmissive bodies never enter the depth/normal target.
export const AO_OCCLUDER_LAYER = 10

// Tuning. The radius is a fixed fraction of the visible body extent so it is
// unit- and zoom-stable (mm and inch copies of the same part agree).
export const AO_RADIUS_FRACTION = 0.03

// One white texel stands in whenever the AO stage does not publish a result
// (option off, capturing, sectioned, or before the first AO frame). The body
// material samples tAO unconditionally, so a null texture would bind three's
// empty one and read black, shading the whole body; importing this twice must
// not build a second texture, hence the module-level instance.
export const aoFallbackTexture = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  texture.needsUpdate = true
  return texture
})()

// The only channel between the AO stage and the body materials: the denoised
// occlusion texture, its full-resolution size and the strength slider. Every
// body material references these same objects, so moving the camera or
// changing strength recompiles nothing.
export const aoUniforms = {
  tAO: { value: aoFallbackTexture as THREE.Texture },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uAoStrength: { value: 1 },
}

// Module-level capturing flag used by the thumbnail path.
let aoCapturing = false
export function setAoCapturing(value: boolean): void { aoCapturing = value }
export function isAoCapturing(): boolean { return aoCapturing }

/** The viewer flags that decide whether AO may run at all. One field per flag;
 *  the analysis modes and the section replace the surface AO would shade. */
export interface AoActiveInput {
  option: boolean
  shading: boolean
  zebra: boolean
  curvature: boolean
  section: boolean
  capturing: boolean
}

export function isAoActive(input: AoActiveInput): boolean {
  return input.option
    && input.shading
    && !input.zebra
    && !input.curvature
    && !input.section
    && !input.capturing
}

export function aoRadiusFor(extent: number): number {
  const measured = Number.isFinite(extent) ? extent : 0
  const radius = measured * AO_RADIUS_FRACTION
  // A model whose extent is not measured yet still needs a usable radius for
  // the first frame; it is replaced on the next one.
  return Number.isFinite(radius) && radius > 0 ? radius : 1
}

/** Put the occluder bit on an opaque face and take it off a see-through one.
 *  `layers` is undefined when the ref receives a stand-in node (a DOM render),
 *  which simply has nothing to mark. */
export function applyAoOccluder(layers: THREE.Layers | undefined, opaque: boolean): void {
  if (!layers) return
  if (opaque) layers.enable(AO_OCCLUDER_LAYER)
  else layers.disable(AO_OCCLUDER_LAYER)
}
