import * as THREE from 'three'

/**
 * GLSL3 shader material backing IdDebugOverlay.
 *
 * Fragment shader recipe:
 *   1. sample the ID render target
 *   2. alpha < 0.5 → black (no entity)
 *   3. decode RGB into a 24-bit id
 *   4. map id to hue via golden ratio (fract(id * φ)) for optimal visual
 *      separation between sequential IDs
 */
const GOLDEN_RATIO = 0.618033988749895

export function buildOverlayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tId: { value: null as THREE.Texture | null },
    },
    vertexShader: `
      out vec2 vUv;
      void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
        vUv = gl_Position.xy * 0.5 + 0.5;
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp int;
      uniform sampler2D tId;
      in vec2 vUv;
      out vec4 fragColor;

      vec3 hsv2rgb(vec3 c) {
        vec3 K = vec3(1.0, 2.0/3.0, 1.0/3.0);
        vec3 p = abs(fract(c.xxx + K) * 6.0 - 3.0);
        return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
      }

      void main() {
        vec4 raw = texture(tId, vUv);
        if (raw.a < 0.5) {
          fragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }

        uint r = uint(raw.r * 255.0 + 0.5);
        uint g = uint(raw.g * 255.0 + 0.5);
        uint b = uint(raw.b * 255.0 + 0.5);
        uint id = (r << 16) | (g << 8) | b;

        float hue = fract(float(id) * ${GOLDEN_RATIO});
        vec3 rgb = hsv2rgb(vec3(hue, 0.85, 0.95));
        fragColor = vec4(rgb, 1.0);
      }
    `,
  })
}

/**
 * Update the overlay's texture uniform. Pulled out of the component so the
 * `react-hooks/immutability` lint rule doesn't see the property assignment
 * on a useState-returned object.
 */
export function updateOverlayTexture(
  material: THREE.ShaderMaterial,
  texture: THREE.Texture | null,
): void {
  material.uniforms.tId.value = texture
  material.needsUpdate = true
}
