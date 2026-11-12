// @vitest-environment jsdom
//
// The audit of the zebra program without a GPU: the patch is a pure function of
// the shader source plus a uniforms record, and the hook is the only thing that
// decides what is compile-time (the mode) and what is a uniform (every slider).
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'
import {
  AO_GLSL,
  CURVATURE_GLSL,
  CURVATURE_HIGHLIGHT_GLSL,
  ZEBRA_GLSL,
  ZEBRA_HIGHLIGHT_GLSL,
  THREAD_GLSL,
  ThreadProgram,
  analysisMaterialName,
  makeZebraPatch,
  selectBodyPatch,
  useBodyAnalysisMaterial,
  type BodyAnalysisMode,
  type BodyAnalysisParams,
  type BodyAnalysisPatch,
} from '@/components/Geometry3D/bodyAnalysisMaterial'
import { aoUniforms } from '@/components/Viewport/ambientOcclusion'

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

// The plain body: no analysis mode, no threads. Every AO test starts here and
// adds the one flag under test, so a cache key can only move because of it.
const plainParams: BodyAnalysisParams = {
  mode: 'none',
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

const curvatureParams: BodyAnalysisParams = {
  mode: 'curvature',
  mixVertexColor: true,
  baseColor: '#112233',
  zebraStripes: 12,
  curvatureKind: 'mean',
  curvatureRange: [-2, 2],
}

function applyCurvature(params: BodyAnalysisParams) {
  const material = new THREE.MeshPhysicalMaterial()
  const ref = { current: material as THREE.Material | null }
  let patch: ReturnType<typeof useBodyAnalysisMaterial> = null
  renderHook(({ p }) => { patch = useBodyAnalysisMaterial(ref, p); return patch }, { initialProps: { p: params } })
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, { value: unknown }>,
  }
  material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never)
  return { material, shader, patch: patch! }
}

describe('curvature material patch', () => {
  it('reads the two scalars from a vertex attribute, not from a texture', () => {
    const { shader, patch } = applyCurvature(curvatureParams)
    expect(shader.vertexShader).toContain('attribute vec2 aCurvature;')
    expect(shader.vertexShader).toContain('vCurvature = aCurvature;')
    expect(shader.fragmentShader).toContain('varying vec2 vCurvature;')
    expect(shader.fragmentShader).toContain(CURVATURE_GLSL)
    expect(shader.fragmentShader).toContain(CURVATURE_HIGHLIGHT_GLSL)
    expect(patch.customProgramCacheKey()).toBe('curvature-vc')
  })

  it('keeps the kind and range as uniforms', () => {
    const { material, shader, patch } = applyCurvature(curvatureParams)
    expect((shader.uniforms.uCurvatureRange.value as THREE.Vector2).toArray()).toEqual([-2, 2])
    expect(shader.uniforms.uCurvatureKind.value).toBe(0)

    const version = material.version
    patch.setCurvature?.('gaussian', [-0.5, 0.5])
    expect(material.version).toBe(version)
    expect((shader.uniforms.uCurvatureRange.value as THREE.Vector2).toArray()).toEqual([-0.5, 0.5])
    expect(shader.uniforms.uCurvatureKind.value).toBe(1)
  })

  it('leaves the vertex-colour highlight out of the assembly variant', () => {
    const material = new THREE.MeshStandardMaterial()
    const ref = { current: material as THREE.Material | null }
    renderHook(() => useBodyAnalysisMaterial(ref, { ...curvatureParams, mixVertexColor: false }))
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    }
    material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never)
    expect(shader.fragmentShader).toContain(CURVATURE_GLSL)
    expect(shader.fragmentShader).not.toContain('uBaseColor')
    expect(shader.uniforms.uBaseColor).toBeUndefined()
  })

  it('switches program identity between zebra and curvature', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const { rerender } = renderHook(
      ({ p }) => useBodyAnalysisMaterial(ref, p),
      { initialProps: { p: zebraParams } },
    )
    expect(material.customProgramCacheKey()).toBe('zebra-vc')
    rerender({ p: curvatureParams })
    expect(material.customProgramCacheKey()).toBe('curvature-vc')
  })
})

describe('vertex-colour highlight shader types', () => {
  // Three declares `varying vec4 vColor` for vertex colours while the base
  // colour uniform is a vec3, and neither `distance` nor `mix` has a vec4/vec3
  // overload. A bare `vColor` fails the whole program, so pin the swizzle in
  // the complete sources the patches hand to the renderer, not just in the
  // exported GLSL fragments.
  function highlightSources(): string[] {
    const zebra = applyPatch(makeZebraPatch({ stripes: 12, baseColor: '#112233', mixVertexColor: true }))
    const curvature = applyCurvature(curvatureParams)
    return [zebra.fragmentShader, curvature.shader.fragmentShader]
  }

  it('compares the vec4 vertex colour through its RGB swizzle', () => {
    for (const source of highlightSources()) {
      expect(source).toContain('distance( vColor.rgb, uBaseColor )')
      expect(source).not.toMatch(/distance\(\s*vColor\s*,/)
    }
  })

  it('mixes the analysis colour with RGB vertex colours', () => {
    const sources = highlightSources()
    expect(sources[0]).toContain('mix( zebraColor, vColor.rgb, zebraHighlight )')
    expect(sources[1]).toContain('mix( curvatureColor, vColor.rgb, curvatureHighlight )')
    for (const source of sources) expect(source).not.toMatch(/mix\(\s*\w+,\s*vColor\s*,/)
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

describe('thread shading patch', () => {
  it('reads the bore frame from vertex attributes and shades after the view-space normal', () => {
    const shader = applyPatch(new ThreadProgram())
    expect(shader.vertexShader).toContain('attribute vec4 aThreadCoord;')
    expect(shader.vertexShader).toContain('attribute vec3 aThreadAxis;')
    expect(shader.fragmentShader.indexOf(THREAD_GLSL)).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <normal_fragment_begin>'),
    )
    // The angle is taken per fragment, never interpolated across the seam.
    expect(THREAD_GLSL).toContain('atan( vThreadCoord.y, vThreadCoord.x')
    // The axis is a surface direction: model-view, not the normal matrix.
    expect(shader.vertexShader).toContain('vThreadAxis = mat3( modelViewMatrix ) * aThreadAxis;')
  })

  it('stays inside the GLSL ES character set and carries no comments', () => {
    // A strict front end refuses a stray backtick or quote even in a comment,
    // and a refused program silently leaves the plain material.
    expect(THREAD_GLSL).toMatch(/^[A-Za-z0-9_ \t\n.+\-*/%<>[\](){}^|&~=!:;,?]*$/)
    expect(THREAD_GLSL).not.toContain('//')
  })

  it('takes its derivatives outside any branch, masking the plain wall instead', () => {
    // dFdx/dFdy in non-uniform control flow are undefined in GLSL ES 3.0.
    expect(THREAD_GLSL).not.toMatch(/\bif\s*\(/)
    expect(THREAD_GLSL).toContain('dFdx')
    // A back face tilts its flanks the same way as the front.
    expect(THREAD_GLSL).toContain('faceDirection')
  })

  it('compiles as its own program, distinct from plain, zebra and curvature', () => {
    const keys = ['zebra', 'curvature', 'none'].map(mode =>
      selectBodyPatch({ ...plainParams, mode: mode as BodyAnalysisMode, threaded: true })?.customProgramCacheKey() ?? '')
    expect(keys).toEqual(['zebra-vc', 'curvature-vc', 'thread'])
    expect(selectBodyPatch({ ...plainParams })).toBeNull()
  })

  it('gives way to an analysis mode, which must show the true surface, and comes back after it', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const plainThreaded: BodyAnalysisParams = { ...zebraParams, mode: 'none', threaded: true }
    const { rerender } = renderHook(
      ({ params }) => useBodyAnalysisMaterial(ref, params),
      { initialProps: { params: plainThreaded } },
    )
    expect(material.customProgramCacheKey()).toBe('thread')
    rerender({ params: { ...plainThreaded, mode: 'zebra' } })
    expect(material.customProgramCacheKey()).toBe('zebra-vc')
    rerender({ params: plainThreaded })
    expect(material.customProgramCacheKey()).toBe('thread')
    rerender({ params: { ...plainThreaded, threaded: false } })
    expect(material.customProgramCacheKey()).toBe('')
  })
})

// AO is a patch on the same material, exactly like zebra: the caller resolves
// the flag (isAoActive) and the program only decides how to sample it. Only
// the strength is live, through the shared uniform.
function applyBodyParams(params: BodyAnalysisParams) {
  const material = new THREE.MeshPhysicalMaterial()
  const ref = { current: material as THREE.Material | null }
  let patch: BodyAnalysisPatch | null = null
  renderHook(({ p }) => { patch = useBodyAnalysisMaterial(ref, p); return patch }, { initialProps: { p: params } })
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, { value: unknown }>,
  }
  material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as never)
  return { material, shader, patch: patch! }
}

describe('ambient occlusion patch', () => {
  it('multiplies only the indirect terms by the sampled occlusion', () => {
    const { shader } = applyBodyParams({ ...plainParams, ao: true })

    expect(shader.fragmentShader).toContain(AO_GLSL)
    expect(shader.fragmentShader).toContain('texture2D( tAO')
    // The patch is inserted before three's own chunk, never instead of it: the
    // material's aoMap and the clearcoat/sheen scaling live in that include.
    const aoAt = shader.fragmentShader.indexOf(AO_GLSL)
    const includeAt = shader.fragmentShader.indexOf('#include <aomap_fragment>')
    expect(aoAt).toBeGreaterThanOrEqual(0)
    expect(includeAt).toBeGreaterThan(aoAt)
    // Direct light and every overlay (selection, hover, edges) are untouched:
    // AO is indirect light only.
    expect(AO_GLSL).not.toContain('reflectedLight.directDiffuse')
    expect(AO_GLSL).not.toContain('reflectedLight.directSpecular')
    expect(shader.uniforms.tAO).toBe(aoUniforms.tAO)
    expect(shader.uniforms.uResolution).toBe(aoUniforms.uResolution)
    expect(shader.uniforms.uAoStrength).toBe(aoUniforms.uAoStrength)
  })

  it('leaves the shader untouched when AO is off', () => {
    const { shader } = applyBodyParams({ ...plainParams, ao: false })
    expect(shader.fragmentShader).not.toContain('tAO')
    expect(shader.uniforms.tAO).toBeUndefined()
  })

  it('gives every program its own key, and an analysis mode never gains AO', () => {
    const key = (params: Partial<BodyAnalysisParams>) =>
      selectBodyPatch({ ...plainParams, ...params })?.customProgramCacheKey() ?? ''

    expect([
      key({}),
      key({ ao: true }),
      key({ threaded: true }),
      key({ threaded: true, ao: true }),
      key({ mode: 'zebra' }),
    ]).toEqual(['', 'ao', 'thread', 'thread+ao', 'zebra-vc'])
    expect(key({ mode: 'zebra', ao: true })).toBe('zebra-vc')
    expect(key({ mode: 'curvature', ao: true })).toBe('curvature-vc')
  })

  it('never samples occlusion on a transparent body', () => {
    expect(selectBodyPatch({ ...plainParams, ao: true, transparent: true })).toBeNull()
    const threaded = selectBodyPatch({ ...plainParams, ao: true, transparent: true, threaded: true })
    expect(threaded?.customProgramCacheKey()).toBe('thread')
  })

  it('moves the strength through the shared uniform without recompiling', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const { rerender } = renderHook(({ p }) => useBodyAnalysisMaterial(ref, p), {
      initialProps: { p: { ...plainParams, ao: true, aoStrength: 0.4 } as BodyAnalysisParams },
    })
    expect(aoUniforms.uAoStrength.value).toBe(0.4)
    const version = material.version
    const compiled = material.onBeforeCompile

    rerender({ p: { ...plainParams, ao: true, aoStrength: 0.9 } })

    expect(aoUniforms.uAoStrength.value).toBe(0.9)
    expect(material.version).toBe(version)
    expect(material.onBeforeCompile).toBe(compiled)
    // The uniform is shared by every body material, so a test that moves it must
    // put it back or the next file's assertions read this value.
    aoUniforms.uAoStrength.value = 1
  })

  it('recompiles the same material instance when AO toggles', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const ref = { current: material as THREE.Material | null }
    const { rerender } = renderHook(({ p }) => useBodyAnalysisMaterial(ref, p), {
      initialProps: { p: { ...plainParams, ao: true } as BodyAnalysisParams },
    })
    expect(material.customProgramCacheKey()).toBe('ao')
    const version = material.version

    rerender({ p: { ...plainParams, ao: false } })

    expect(material.customProgramCacheKey()).toBe('')
    expect(material.version).toBeGreaterThan(version)
    expect(ref.current).toBe(material)
  })
})
