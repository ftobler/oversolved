// One global brightness for the whole 3D scene, applied as the renderer's
// `toneMappingExposure`.
//
// Exposure rather than light intensity because it scales every tone-mapped
// material at once: bodies, the body edges (edgeLineMaterial compiles
// `tonemapping_fragment` in), sketches and planes. Scaling only ENV_INTENSITY
// would brighten the lit bodies but leave the unlit lines behind, which is not
// the global control the user asked for.
//
// It does NOT touch the ID buffer. Those layers are ShaderMaterials that never
// include the tone-mapping chunk, so the ids they write are the same at any
// exposure. Picking therefore cannot move when the slider does.
//
// A hook rather than a component inside the Canvas: both viewports already hold
// the renderer in a ref from `onCreated`, so setting exposure there needs no
// scene-tree child -- and a child would have forced every test that mocks
// @react-three/fiber to grow a `useThree` stub.
import { useEffect, type RefObject } from 'react'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

export interface ExposureTarget {
  toneMappingExposure: number
}

/** The whole effect of the slider, pure so the default and the write are
 *  pinned without a renderer. */
export function applyExposure(target: ExposureTarget, brightness: number): void {
  target.toneMappingExposure = brightness
}

/**
 * Write the stored brightness onto the renderer, and ask for a frame because a
 * uniform on the renderer is not an R3F instance change: the on-demand canvas
 * would otherwise show it only on the next camera move.
 *
 * `ready` is the viewport's scene-readiness tick: the ref is empty until
 * `onCreated` has run, and that callback bumps the tick, which re-runs this
 * effect with the renderer in hand.
 */
export function useSceneExposure(
  glRef: RefObject<ExposureTarget | null>,
  invalidateRef: RefObject<(() => void) | null> | undefined,
  ready: number,
): void {
  const brightness = useViewOptionsStore(s => s.brightness)

  useEffect(() => {
    const gl = glRef.current
    if (!gl) return
    applyExposure(gl, brightness)
    invalidateRef?.current?.()
  }, [glRef, invalidateRef, brightness, ready])
}
