import * as THREE from 'three'
import { EDGE_DEPTH_BIAS } from '@/picking/EdgeIdLayer'

// A depth-biased, vertex-coloured line material for the visible B-rep wireframe.
// It is a real (non-raw) ShaderMaterial, so R3F's ACES + sRGB output transforms
// are DEFINED in the fragment prefix but not applied unless the body applies
// them: the two includes below are what keep an edge painted COLOR_SELECTED here
// the same on-screen colour as the same constant on the drei <lineBasicMaterial>
// selection overlay (which is tone-mapped and encoded like every other material).
export const EDGE_VERT_SHADER = `
  varying vec3 vColor;
  uniform float uDepthBias;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clip.z += uDepthBias * clip.w;
    vColor = color;
    gl_Position = clip;
  }
`

export const EDGE_FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function buildEdgeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT_SHADER,
    fragmentShader: EDGE_FRAG_SHADER,
    uniforms: { uDepthBias: { value: EDGE_DEPTH_BIAS } },
    vertexColors: true,
  })
}
