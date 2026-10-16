// Mesh-export tessellation quality. One shared table, deliberately small: three
// named presets rather than a free slider, so the dialog cannot offer a mesh the
// kernel was never tuned for. Lives in the kernel (not the Viewport) because the
// worker resolves the name and the dialog only chooses it.
//
// `normal` reproduces the pre-preset export exactly: the old dialog slider
// defaulted to 0.5, and serialiseShape mapped that to linear = 0.5*2 = 1.0 and
// angular = 0.5*0.6 = 0.3. A default export therefore produces the same mesh as
// it always did. The other two scale that pair by 0.5 (finer, more triangles)
// and 2 (coarser, fewer), stepping both deflections together.

export type TessellationPreset = 'fine' | 'normal' | 'coarse'

export interface TessellationParams {
  // Chord tolerance handed to BRepMesh_IncrementalMesh. The export path meshes
  // with isRelative=false, so this is an absolute tolerance in model units.
  linearDeflection: number
  // Maximum angle between adjacent facets; usually the term that binds the
  // triangle count on curved faces.
  angularDeflection: number
}

export const TESSELLATION_PRESETS: Record<TessellationPreset, TessellationParams> = {
  fine: { linearDeflection: 0.5, angularDeflection: 0.15 },
  normal: { linearDeflection: 1, angularDeflection: 0.3 },
  coarse: { linearDeflection: 2, angularDeflection: 0.6 },
}

// Display and test order, finest first. Kept as data so the dialog renders the
// presets in one place rather than spelling the union out again.
export const TESSELLATION_PRESET_ORDER: readonly TessellationPreset[] = ['fine', 'normal', 'coarse']

export const DEFAULT_TESSELLATION_PRESET: TessellationPreset = 'normal'

/** The deflection params for a preset; `normal` (today's mesh) when none. */
export function resolveTessellation(preset?: TessellationPreset): TessellationParams {
  return TESSELLATION_PRESETS[preset ?? DEFAULT_TESSELLATION_PRESET]
}
