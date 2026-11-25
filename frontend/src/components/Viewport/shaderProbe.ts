import { useEffect, type RefObject } from 'react'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

// A dev-only console probe for lazy WebGL shader compilation. three adds an
// entry to renderer.info.programs the first time a program is used, so the
// delta across one render names exactly the shaders that frame had to compile
// and how long that compile made the render take.
//
// The hook patches gl.render: both viewports draw through it (the part editor's
// MsaaPresenter calls it, R3F calls it directly in the assembly), so one thin
// shell covers both without either viewport owning a frame callback. Patching
// the renderer keeps the diff and the patch free of three and the DOM, so they
// are testable headlessly; the React hook at the bottom only owns its lifetime.
// The timer spans that one render call: a presented frame can hold several
// passes, and each program is charged to the pass that compiled it rather than
// to a total the probe cannot see from inside the renderer.

export interface ProbeProgram {
  name: string
  cacheKey: string
}

// Method syntax keeps a real WebGLRenderer, whose render takes Object3D and
// Camera, assignable to this minimal shape without a cast at the call site.
export interface ShaderProbeRenderer {
  render(scene: unknown, camera: unknown): void
  info: { programs: ProbeProgram[] | null }
}

/** Programs in `after` that are not in `before`, compared by identity. */
export function diffPrograms<T>(before: readonly T[], after: readonly T[]): T[] {
  const seen = new Set<T>(before)
  return after.filter(program => !seen.has(program))
}

const CACHE_KEY_LENGTH = 80

export function attachShaderProbe(gl: ShaderProbeRenderer, label: string): () => void {
  const original = gl.render
  gl.render = (scene, camera) => {
    // Copy the list: three mutates it in place, so a live reference would
    // already hold the new programs when the after-snapshot is taken.
    const before = gl.info.programs ? [...gl.info.programs] : []
    const start = performance.now()
    original.call(gl, scene, camera)
    const elapsed = performance.now() - start
    const after = gl.info.programs ?? []
    const prefix = `[shader-probe ${label}]`
    for (const program of diffPrograms(before, after)) {
      const key = program.cacheKey.slice(0, CACHE_KEY_LENGTH)
      console.log(`${prefix} name=${program.name} cacheKey=${key} frame=${elapsed.toFixed(2)}ms`)
    }
  }
  // Restoring the exact function handed in keeps a second attach/detach pair
  // (StrictMode's remount) from stacking wrappers on the same renderer.
  return () => { gl.render = original }
}

/**
 * Owns the wrapper's lifetime from the viewer-debug flag. Both viewports hold a
 * renderer ref and a readiness tick from onCreated, so the hook waits for the
 * renderer and tears the wrapper down on a flag toggle, a Canvas rebuild or an
 * unmount (StrictMode's remount included).
 */
export function useShaderProbe(
  glRef: RefObject<ShaderProbeRenderer | null>,
  ready: number,
  label: string,
): void {
  const enabled = useViewOptionsStore(s => s.shaderProbe)
  useEffect(() => {
    const gl = glRef.current
    if (!enabled || !gl) return
    return attachShaderProbe(gl, label)
  }, [glRef, enabled, ready, label])
}
