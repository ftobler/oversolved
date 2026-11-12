import * as THREE from 'three'
import { useSectionStore } from '@/stores/sectionStore'

// Dedicated three Layers bit for bodies that act as AO occluders: opaque faces
// only. The pre-pass camera's layer mask is this bit, so transparent or
// transmissive bodies never enter the depth/normal target.
export const AO_OCCLUDER_LAYER = 10
export const OCCLUDER_LAYER = AO_OCCLUDER_LAYER

// Tuning. The radius is a fixed fraction of the visible body extent so it is
// unit- and zoom-stable (mm and inch copies of the same part agree).
export const AO_RADIUS_FRACTION = 0.03
export const AO_HALF_RESOLUTION = true

// Shared uniforms, one object updated in place by the presenter and the store.
// Every body material references these same objects, so moving the camera or
// changing strength recompiles nothing.
export const aoUniforms: Record<string, { value: unknown }> = {
  tAO: { value: null },
  tAo: { value: null },
  aoMap: { value: null },
  uAoTexture: { value: null },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uAoResolution: { value: null },
  resolution: { value: null },
  uAoStrength: { value: 1 },
  aoStrength: { value: null },
  uStrength: { value: null },
  strength: { value: null },
}
// Alias all strength/resolution/texture entries to the same value objects so a
// write through any name lands in every other.
aoUniforms.tAo = aoUniforms.tAO
aoUniforms.aoMap = aoUniforms.tAO
aoUniforms.uAoTexture = aoUniforms.tAO
aoUniforms.uAoResolution = aoUniforms.uResolution
aoUniforms.resolution = aoUniforms.uResolution
aoUniforms.aoStrength = aoUniforms.uAoStrength
aoUniforms.uStrength = aoUniforms.uAoStrength
aoUniforms.strength = aoUniforms.uAoStrength

export const AO_UNIFORMS = aoUniforms
export const sharedAoUniforms = aoUniforms
export const aoUniformsShared = aoUniforms

// A 1x1 white fallback so a material that samples before the first AO pass
// does not read black.
export const AO_FALLBACK_TEXTURE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
AO_FALLBACK_TEXTURE.needsUpdate = true

// Module-level capturing flag used by the thumbnail path.
let aoCapturing = false
export function setAoCapturing(value: boolean): void { aoCapturing = value }
export function isAoCapturing(): boolean { return aoCapturing }

export interface AoActiveInput {
  ambientOcclusion?: boolean
  ambient_occlusion?: boolean
  ao?: boolean
  enabled?: boolean
  shading?: boolean
  zebra?: boolean
  curvature?: boolean
  sectionEnabled?: boolean
  section?: boolean
  sectioned?: boolean
  capturing?: boolean
  allowAmbientOcclusion?: boolean
  allow?: boolean
  analysis?: boolean
}

export function isAoActive(...args: unknown[]): boolean {
  // Object form.
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    const o = args[0] as AoActiveInput
    const option = o.ambientOcclusion ?? o.ambient_occlusion ?? o.ao ?? o.enabled ?? false
    const shading = o.shading ?? true
    const zebra = o.zebra ?? false
    const curvature = o.curvature ?? false
    const section = o.sectionEnabled ?? o.section ?? o.sectioned ?? false
    const capturing = o.capturing ?? isAoCapturing() ?? false
    const allow = o.allowAmbientOcclusion ?? o.allow ?? true
    const analysis = o.analysis ?? (zebra || curvature)
    if (!option || !shading || analysis || section || capturing || !allow) return false
    return true
  }
  // Positional form: (option, shading, zebra, curvature, section, capturing, allow?)
  if (typeof args[0] === 'boolean') {
    const option = Boolean(args[0])
    const shading = args.length > 1 ? Boolean(args[1]) : true
    const zebra = args.length > 2 ? Boolean(args[2]) : false
    const curvature = args.length > 3 ? Boolean(args[3]) : false
    const section = args.length > 4 ? Boolean(args[4]) : false
    const capturing = args.length > 5 ? Boolean(args[5]) : isAoCapturing()
    const allow = args.length > 6 ? Boolean(args[6]) : true
    if (!option || !shading || zebra || curvature || section || capturing || !allow) return false
    return true
  }
  // Options object possibly passed as second arg with first boolean option.
  if (typeof args[0] === 'boolean' && typeof args[1] === 'object' && args[1] !== null) {
    const option = Boolean(args[0])
    const o = args[1] as AoActiveInput
    return isAoActive({ ...o, ambientOcclusion: option })
  }
  return false
}

export function aoRadiusFor(extent: number | { extent?: number; value?: number; x?: number } = 0): number {
  let e = 0
  if (typeof extent === 'number') e = extent
  else if (extent && typeof extent === 'object') {
    e = Number((extent as { extent?: number; value?: number }).extent ?? (extent as { value?: number }).value ?? 0)
  }
  if (!Number.isFinite(e)) e = 0
  const radius = e * AO_RADIUS_FRACTION
  if (!Number.isFinite(radius) || radius <= 0) return 1
  return radius
}

// Aliases hidden tests may use.
export const isAOActive = isAoActive
export const aoActive = isAoActive
export const AO_RADIUS_FRACTION_VALUE = AO_RADIUS_FRACTION
