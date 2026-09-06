// The ID-layer shaders share the shape of the visible edge shader
// (gl_FragColor = vec4(vColor, 1.0)) but MUST NOT tone-map or output-encode:
// they target a plain RGBA8 pick buffer that has to hold the exact bytes the id
// encodes. This pins the asymmetry so a future "consistency" refactor that adds
// the transforms to edgeLineMaterial.ts cannot also break the pick buffer.
import { describe, it, expect } from 'vitest'
import { EDGE_ID_FRAG_SHADER } from '@/picking/EdgeIdLayer'

describe('ID-layer edge shader', () => {
  it('does NOT tone-map or output-encode (it targets the raw pick buffer)', () => {
    expect(EDGE_ID_FRAG_SHADER).not.toContain('#include <tonemapping_fragment>')
    expect(EDGE_ID_FRAG_SHADER).not.toContain('#include <colorspace_fragment>')
  })

  it('writes the packed colour straight through', () => {
    expect(EDGE_ID_FRAG_SHADER).toContain('gl_FragColor = vec4(vColor, 1.0)')
  })
})
