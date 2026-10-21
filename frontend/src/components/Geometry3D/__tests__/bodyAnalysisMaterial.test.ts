// The audit of the zebra program without a GPU: the patch is a pure function of
// the shader source plus a uniforms record, and the hook is the only thing that
// decides what is compile-time (the mode) and what is a uniform (every slider).
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'
import {
  ZEBRA_GLSL,
  ZEBRA_HIGHLIGHT_GLSL,
  analysisMaterialName,
  makeZebraPatch,
  useBodyAnalysisMaterial,
  type BodyAnalysisParams,
} from '@/components/Geometry3D/bodyAnalysisMaterial'

function applyPatch(patch: ReturnType<typeof makeZebraPatch>) {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, { value: unknown }>,
  }
  patch.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms)
  return shader
}

const zebraParams: BodyAnalysisParams = {
  mode: 'zebra',
  mixVertexColor: true,
  baseColor: '#112233',
  zebraStripes: 12,
  curvatureKind: 'mean',
  curvatureRange: [-1, 1],
}

describe('zebra material patch', () => {
  it('injects the stripe program after the view-space normal exists', () => {
    const patch = makeZebraPatch({ stripes: 12, baseColor: '#112233', mixVertexColor: true })
    const shader = applyPatch(patch)

    expect(shader.fragmentShader).toContain(ZEBRA_GLSL)
    expect(shader.fragmentShader).toContain('#include <normal_fragment_begin>\n')
    // The stripe maths needs `normal` and `vViewPosition`; both are in scope
    // only at this point in the physical fragment shader.
    expect(shader.fragmentShader.indexOf(ZEBRA_GLSL)).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <normal_fragment_begin>'),
    )
    expect(patch.customProgramCacheKey()).toBe('zebra-vc')
  })

  it('mixes the vertex-colour highlight instead of overwriting it', () => {
    const shader = applyPatch(makeZebraPatch({ stripes: 12, baseColor: '#112233', mixVertexColor: true }))
    expect(shader.fragmentShader).toContain(ZEBRA_HIGHLIGHT_GLSL)
    expect(ZEBRA_HIGHLIGHT_GLSL).toContain('vColor')
    expect(ZEBRA_HIGHLIGHT_GLSL).toContain('uBaseColor')
    expect(shader.uniforms.uBaseColor.value).toBeInstanceOf(THREE.Color)
  })

  it('leaves the vertex colour out for the assembly, which has none', () => {
    const patch = makeZebraPatch({ stripes: 12, baseColor: '#112233', mixVertexColor: false })
    const shader = applyPatch(patch)
    expect(shader.fragmentShader).not.toContain('uBaseColor')
    expect(shader.fragmentShader).not.toContain(ZEBRA_HIGHLIGHT_GLSL)
    expect(shader.uniforms.uBaseColor).toBeUndefined()
    expect(patch.customProgramCacheKey()).toBe('zebra-plain')
  })

  it('names the material by mode', () => {
    expect(analysisMaterialName('zebra')).toBe('zebra-material')
    expect(analysisMaterialName('curvature')).toBe('curvature-material')
    expect(analysisMaterialName('none')).toBe('body-material')
  })
})

describe('useBodyAnalysisMaterial', () => {
  it('updates slider values through uniforms without recompiling', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const { rerender } = renderHook(
      ({ params }) => useBodyAnalysisMaterial(ref, params),
      { initialProps: { params: zebraParams } },
    )

    expect(material.customProgramCacheKey()).toBe('zebra-vc')
    const compiled = material.onBeforeCompile
    // `needsUpdate` is a setter that bumps `version`; that integer is the only
    // readable record of a requested recompile.
    const version = material.version

    rerender({ params: { ...zebraParams, zebraStripes: 30 } })
    expect(material.version).toBe(version)
    expect(material.onBeforeCompile).toBe(compiled)
  })

  it('keeps the base colour uniform in step with selection and part colour', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    let currentUniforms: ReturnType<typeof makeZebraPatch>['uniforms'] | null = null
    const { rerender } = renderHook(({ params }) => {
      const patch = useBodyAnalysisMaterial(ref, params)
      currentUniforms = patch?.uniforms ?? null
      return patch
    }, { initialProps: { params: zebraParams } })

    expect(currentUniforms!.uBaseColor!.value.getHexString()).toBe('112233')
    rerender({ params: { ...zebraParams, baseColor: '#abcdef' } })
    expect(currentUniforms!.uBaseColor!.value.getHexString()).toBe('abcdef')
  })

  it('restores the default material hooks when the mode turns off', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const { rerender } = renderHook(
      ({ params }) => useBodyAnalysisMaterial(ref, params),
      { initialProps: { params: zebraParams } },
    )
    expect(material.customProgramCacheKey()).toBe('zebra-vc')

    rerender({ params: { ...zebraParams, mode: 'none' } })
    expect(material.customProgramCacheKey()).toBe('')

    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {},
    }
    material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never)
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader)
  })
})
