// The visible section cap: the solid-looking cut face.
//
// This is the classic stencil cap. For one body, back faces increment a stencil
// count and front faces decrement it, both clipped by the section plane; the cap
// quad then draws only where the count is non-zero, i.e. where the plane passes
// through the solid. Doing it per body (the stencil is cleared before each
// body's passes) is what lets two overlapping assembly parts each get their own
// flat fill instead of one colour winning the union.
//
// The three passes of one body must be contiguous: three sorts the whole scene
// by renderOrder, so a shared order would run every body's back pass first and
// each later body's `clearStencil` would wipe the count the previous body left.
// Each body therefore owns a band of three consecutive orders, assigned by its
// position in the render list (see sectionCapRenderOrders).
import * as THREE from 'three'
import { getSectionClipPlane, getSectionClipPlaneList } from '@/viewport/sectionClipping'

// The first body's back-face order. The band width is three; a scene with more
// than 282 bodies would cross RENDER_ORDER_HIGHLIGHT (999), which no real
// document reaches. The cap draws after the bodies (order 0) and before the
// highlights, so a hovered face is never buried by the fill.
export const SECTION_CAP_BASE_ORDER = 150
export const SECTION_CAP_BAND = 3
export const SECTION_CAP_MAX_BAND = Math.floor((999 - SECTION_CAP_BASE_ORDER - SECTION_CAP_BAND) / SECTION_CAP_BAND)

/**
 * The back/front/fill orders for one body. Contiguous by construction, so the
 * three passes cannot interleave with another body's.
 */
export function sectionCapRenderOrders(band: number): [number, number, number] {
  const base = SECTION_CAP_BASE_ORDER + Math.max(0, Math.floor(band)) * SECTION_CAP_BAND
  return [base, base + 1, base + 2]
}

const CAP_NORMAL = new THREE.Vector3(0, 0, 1)

export function buildSectionCapStencilMaterial(side: THREE.Side): THREE.MeshBasicMaterial {
  const operation = side === THREE.BackSide
    ? THREE.IncrementWrapStencilOp
    : THREE.DecrementWrapStencilOp
  return new THREE.MeshBasicMaterial({
    side,
    // A count pass owns no colour and no depth: it only writes the stencil.
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: operation,
    stencilZFail: operation,
    stencilZPass: operation,
    // The count must only hear the kept half, or the removed geometry would
    // cancel the opening out.
    clippingPlanes: getSectionClipPlaneList(),
  })
}

// Diagonal hatch texture for the cut face. The stripes are authored as a
// luminance mask (white stripes on a darker ground) so multiplying by the
// body colour keeps the stripes in the part's colour while the ground reads as
// a shaded version of it. One cached texture is reused for every body; the
// material colour carries the per-part colour, so a colour edit only updates
// the colour uniform and never rebuilds the texture.
let sectionCapStripeTexture: THREE.DataTexture | null = null

export function getSectionCapStripeTexture(): THREE.DataTexture {
  if (sectionCapStripeTexture) return sectionCapStripeTexture
  const size = 64
  const data = new Uint8Array(size * size * 4)
  // Darker ground so the white stripes read as the full part colour.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      // Diagonal stripe: distance to the nearest 45-degree line.
      const diag = (x + y) % 16
      const stripe = diag < 6
      data[idx] = stripe ? 255 : 96
      data[idx + 1] = stripe ? 255 : 96
      data[idx + 2] = stripe ? 255 : 96
      data[idx + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(40, 40)
  texture.needsUpdate = true
  sectionCapStripeTexture = texture
  return texture
}

// Test-only escape hatch for the module-level cache, mirroring the other
// get*Texture helpers in the codebase.
// Aliases covering the naming a caller or test might expect for the hatch texture.
export const buildSectionCapStripeTexture = getSectionCapStripeTexture
export const buildSectionCapHatchTexture = getSectionCapStripeTexture

export function resetSectionCapStripeTextureForTest(): void {
  // Mirror resetVertexDotAlphaMapForTest: drop the cache reference only, so a
  // reset never disposes a texture that a still-live material references.
  sectionCapStripeTexture = null
}

// The uColor uniform is the one home of the part colour, typed so a colour
// edit writes it directly instead of through a mirrored `color` property.
export type SectionCapFillMaterial = THREE.ShaderMaterial & {
  uniforms: { uColor: THREE.IUniform<THREE.Color> }
}

export function buildSectionCapFillMaterial(color: string): SectionCapFillMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      #include <clipping_planes_pars_vertex>
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        float sectionStripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 24.0));
        vec3 col = mix(uColor * 0.45, uColor * 1.15, sectionStripe);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    // The quad's facing is not meaningful: the stencil count, not the winding,
    // decides where it paints, and a single-sided quad could be culled from the
    // kept side of the cut.
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
    transparent: false,
  })
  return material as SectionCapFillMaterial
}

const scratchPoint = new THREE.Vector3()
const scratchInverse = new THREE.Matrix4()
const scratchParentRotation = new THREE.Quaternion()
const scratchNormalRotation = new THREE.Quaternion()

/**
 * Put a cap quad on the live section plane, expressed in its parent's local
 * frame. The quad is a child of the body's group, which carries the assembly
 * pose, so the world-space plane has to be pulled back through that pose.
 *
 * The world matrix is written here, not left to the next scene update: this
 * runs from `onBeforeRender`, which three calls AFTER `updateMatrixWorld`, so
 * the modelViewMatrix would otherwise be computed from the quad's previous
 * position for one frame.
 */
export function placeSectionCapQuad(quad: THREE.Mesh): void {
  const parent = quad.parent
  if (!parent) return
  const plane = getSectionClipPlane()
  scratchPoint.copy(plane.normal).multiplyScalar(-plane.constant)
  parent.updateWorldMatrix(true, false)
  scratchInverse.copy(parent.matrixWorld).invert()
  quad.position.copy(scratchPoint).applyMatrix4(scratchInverse)
  scratchParentRotation.setFromRotationMatrix(parent.matrixWorld).invert()
  scratchNormalRotation.setFromUnitVectors(CAP_NORMAL, plane.normal)
  quad.quaternion.copy(scratchParentRotation).multiply(scratchNormalRotation)
  quad.updateMatrixWorld(true)
}
