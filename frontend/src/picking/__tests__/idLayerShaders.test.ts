// The ID-layer shaders share the shape of the visible edge shader
// (gl_FragColor = vec4(vColor, 1.0)) but MUST NOT tone-map or output-encode:
// they target a plain RGBA8 pick buffer that has to hold the exact bytes the id
// encodes. This pins the asymmetry so a future "consistency" refactor that adds
// the transforms to edgeLineMaterial.ts cannot also break the pick buffer.
import { describe, it, expect } from 'vitest'
import type * as THREE from 'three'
import { IdPipeline } from '@/picking/IdPipeline'
import { EDGE_ID_FRAG_SHADER } from '@/picking/EdgeIdLayer'

describe('ID-layer edge shader', () => {
  it('does NOT tone-map or output-encode (it targets the raw pick buffer)', () => {
    expect(EDGE_ID_FRAG_SHADER).not.toContain('#include <tonemapping_fragment>')
    expect(EDGE_ID_FRAG_SHADER).not.toContain('#include <colorspace_fragment>')
  })

  it('writes the packed colour straight through', () => {
    expect(EDGE_ID_FRAG_SHADER).toContain('gl_FragColor = vec4(vColor, 1.0)')
  })

  it('keeps every B-rep ID material out of the tone-mapping path', () => {
    // Brightness is the renderer's toneMappingExposure, which only changes the
    // image of materials that compile the tone-mapping chunk. The ID materials
    // must not, or moving the Brightness slider would change the bytes the pick
    // pass reads back and every id would decode differently.
    const p = new IdPipeline({ width: 8, height: 8 })
    p.faceLayer.registerBody({
      bodyKey: 'b',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['face@b#0'],
    })
    p.edgeLayer.registerBody({
      bodyKey: 'b',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['edge@b#0'],
    })
    p.vertexLayer.registerBody({ bodyKey: 'b', vertices: [[0, 0, 0]], vertexQueries: ['vtx@b#0'] })

    for (const layer of [p.faceLayer, p.edgeLayer, p.vertexLayer]) {
      const obj = layer.scene.children[0] as THREE.Mesh
      const material = obj.material as THREE.ShaderMaterial
      expect(material.fragmentShader).not.toContain('tonemapping_fragment')
      expect(material.fragmentShader).not.toContain('colorspace_fragment')
    }
    p.dispose()
  })
})
