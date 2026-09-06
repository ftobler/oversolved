// M2: the visible B-rep edge shader is a non-raw ShaderMaterial, so R3F's ACES
// tone mapping + sRGB output encoding are DEFINED in the fragment prefix but only
// applied if the shader body applies them. Without the two includes below, an
// edge painted COLOR_SELECTED came out a different on-screen colour than the same
// constant on the drei <lineBasicMaterial> selection overlay (which is
// tone-mapped and encoded like every other visible material).
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { EDGE_FRAG_SHADER, buildEdgeMaterial } from '@/components/Geometry3D/edgeLineMaterial'
import { EDGE_DEPTH_BIAS } from '@/picking/EdgeIdLayer'

describe('EDGE_FRAG_SHADER colour output', () => {
  it('applies tone mapping and output-colorspace encoding, like every other visible material', () => {
    expect(EDGE_FRAG_SHADER).toContain('#include <tonemapping_fragment>')
    expect(EDGE_FRAG_SHADER).toContain('#include <colorspace_fragment>')
  })

  it('applies the transforms after writing gl_FragColor, not before', () => {
    const assign = EDGE_FRAG_SHADER.indexOf('gl_FragColor = vec4(vColor')
    const tone = EDGE_FRAG_SHADER.indexOf('#include <tonemapping_fragment>')
    const space = EDGE_FRAG_SHADER.indexOf('#include <colorspace_fragment>')
    expect(assign).toBeGreaterThanOrEqual(0)
    expect(tone).toBeGreaterThan(assign)
    expect(space).toBeGreaterThan(tone)
  })

  it('buildEdgeMaterial is a non-raw ShaderMaterial with vertexColors and the depth-bias uniform', () => {
    const m = buildEdgeMaterial()
    expect(m).toBeInstanceOf(THREE.ShaderMaterial)
    expect((m as THREE.RawShaderMaterial).isRawShaderMaterial).toBeFalsy()
    expect(m.vertexColors).toBe(true)
    expect(m.uniforms.uDepthBias.value).toBe(EDGE_DEPTH_BIAS)
    m.dispose()
  })
})
