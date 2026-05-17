import * as THREE from 'three'

/**
 * GLSL3 shader material backing IdDebugOverlay.
 *
 * Fragment shader recipe (mirrors `picking/bitReverse24.ts`):
 *   1. sample the ID render target
 *   2. discard pixels with alpha < 0.5 (empty)
 *   3. decode RGB into a 24-bit id and reverse-bit scramble it
 *   4. take the low 16 bits as a hue at saturation 0.85, value 0.95
 *
 * Keep `reverse24` here in sync with the TypeScript counterpart.
 */
export function buildOverlayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tId: { value: null as THREE.Texture | null },
      opacity: { value: 1.0 },
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
      uniform float opacity;
      in vec2 vUv;
      out vec4 fragColor;

      uint reverse24(uint v) {
        v = v & 0xFFFFFFu;
        v = ((v & 0x555555u) << 1) | ((v & 0xAAAAAAu) >> 1);
        v = ((v & 0x333333u) << 2) | ((v & 0xCCCCCCu) >> 2);
        v = ((v & 0x0F0F0Fu) << 4) | ((v & 0xF0F0F0u) >> 4);
        v = ((v & 0x0000FFu) << 16) | (v & 0x00FF00u) | ((v & 0xFF0000u) >> 16);
        return v & 0xFFFFFFu;
      }

      vec3 hsv2rgb(vec3 c) {
        vec3 K = vec3(1.0, 2.0/3.0, 1.0/3.0);
        vec3 p = abs(fract(c.xxx + K) * 6.0 - 3.0);
        return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
      }

      void main() {
        vec4 raw = texture(tId, vUv);
        if (raw.a < 0.5) discard;

        uint r = uint(raw.r * 255.0 + 0.5);
        uint g = uint(raw.g * 255.0 + 0.5);
        uint b = uint(raw.b * 255.0 + 0.5);
        uint id = (r << 16) | (g << 8) | b;
        uint scrambled = reverse24(id);

        float hue = float(scrambled & 0xFFFFu) / 65535.0;
        vec3 rgb = hsv2rgb(vec3(hue, 0.85, 0.95));
        fragColor = vec4(rgb, opacity);
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
