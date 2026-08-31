import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { VERTEX_LAYER_NAME } from './layerNames'
import { CUBE_CORNER_SIGNS, CUBE_TRIANGLE_INDICES } from './screenSpaceScale'

/**
 * Concrete ID layer for B-rep vertices.
 *
 * Each registered body becomes one drawable with per-vertex ID colors. The
 * ID buffer's windowed resolver (default 17px) provides the snap radius, so
 * the drawn footprint only has to mark where the vertex is, not how far the
 * snap reaches.
 *
 * Two shapes, chosen by `cubePixels`:
 *
 * - unset (helper reusers: sketch vertices, origin marker, dimension labels):
 *   one THREE.Points of 1-pixel dots with `depthTest = false`. These are
 *   gizmo-style overlays that are meant to win unconditionally.
 * - set (B-rep vertices in the part and assembly viewports): one THREE.Mesh
 *   of view-aligned cubes, each `cubePixels` pixels on a side at any zoom.
 *   The cube's depth extent is what ranks it above the face and edge it sits
 *   on, so this layer needs no depth-test escape hatch: it runs `depthTest =
 *   true` and the depth buffer resolves vertex over edge over face by itself.
 *   The same depth test correctly hides vertices on the far side of a solid,
 *   matching how the edge layer already behaves.
 */
export { VERTEX_LAYER_NAME }
export const VERTEX_CUBE_DEPTH_BIAS = -2e-4

export interface VertexIdLayerConfig {
  name?: string
  priority?: number
  zPolicy?: LayerZPolicy
  /**
   * Draw each vertex as a screen-space cube of this many pixels on a side
   * instead of a 1-pixel depth-less point. See the class doc comment.
   */
  cubePixels?: number
  /**
   * Clip-space depth bias applied to cube vertices. Mirrors the edge layer's
   * `EDGE_DEPTH_BIAS` pattern: a small negative bias moves the vertex cube
   * slightly toward the camera so it reliably wins over coplanar faces and
   * edges at all frustum depths. Only used when cubePixels is set.
   */
  depthBias?: number
}

export interface VertexBodyRegistration {
  bodyKey: string
  vertices: ReadonlyArray<[number, number, number]>
  vertexQueries: ReadonlyArray<string>
  /**
   * When true, allocate the ID by a per-primitive key (`bodyKey#layer#vertexIdx`)
   * rather than by the query string. B-rep vertices set this because their
   * queries can legitimately collide (no minted UUID / shared octant); other
   * reusers with unique keys leave it off. Mirrors FaceIdLayer / EdgeIdLayer.
   */
  perPrimitivePickKeys?: boolean
}

const VERT_SHADER = `
  attribute vec3 aColor;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    // Written explicitly: gl_PointSize is UNDEFINED in GLSL ES when a POINTS
    // draw leaves it unset. Desktop GL happens to hand back the fixed-function
    // 1.0 this layer has always assumed, but a driver that zero-initialises
    // vertex outputs marks nothing at all -- every sketch vertex, the origin
    // and every dimension label silently unpickable -- and ANGLE's point-sprite
    // emulation expands the point to a quad of that undefined size. One pixel
    // is the right size: the resolver's window supplies the reach.
    gl_PointSize = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

// Mirrors worldUnitsPerPixel() from ./screenSpaceScale. It has to live in the
// shader because under a perspective camera the pixel size depends on each
// vertex's own view depth; projectionMatrix[2][3] is -1 for perspective and 0
// for orthographic, which selects the right clip-space w.
const CUBE_VERT_SHADER = `
  attribute vec3 aColor;
  attribute vec3 aCorner;
  uniform float uHalfPixels;
  uniform float uViewportHeight;
  uniform float uDepthBias;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    float clipW = projectionMatrix[2][3] == 0.0 ? 1.0 : -view.z;
    float unitsPerPixel = (2.0 * clipW) / (projectionMatrix[1][1] * max(uViewportHeight, 1.0));
    view.xyz += aCorner * (uHalfPixels * unitsPerPixel);
    vec4 clip = projectionMatrix * view;
    clip.z += uDepthBias * clip.w;
    gl_Position = clip;
  }
`

function buildVertexIdMaterial(cubePixels?: number, depthBias?: number): THREE.ShaderMaterial {
  if (cubePixels === undefined) {
    return new THREE.ShaderMaterial({
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      depthTest: false,
      depthWrite: false,
    })
  }
  return new THREE.ShaderMaterial({
    vertexShader: CUBE_VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    uniforms: {
      uHalfPixels: { value: cubePixels / 2 },
      uViewportHeight: { value: 1 },
      uDepthBias: { value: depthBias ?? VERTEX_CUBE_DEPTH_BIAS },
    },
    // DoubleSide so the near cube face marks the pixel regardless of winding;
    // depthWrite stays off (as on edges) so the cubes do not punch 3px holes
    // in the face depth that later layers test against.
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
  })
}

function buildPointGeometry(positions: Float32Array, colors: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor',   new THREE.BufferAttribute(colors,    3))
  return geometry
}

/**
 * Expand one point per vertex into 8 cube corners sharing that vertex's
 * position and ID color. The shader displaces each corner along the view axes
 * by `aCorner * halfExtent`, so the cube is built entirely at draw time and
 * stays a constant pixel size without rebuilding this buffer on zoom.
 */
function buildCubeGeometry(positions: Float32Array, colors: Float32Array, count: number): THREE.BufferGeometry {
  const corners = CUBE_CORNER_SIGNS.length
  const cubePositions = new Float32Array(count * corners * 3)
  const cubeColors    = new Float32Array(count * corners * 3)
  const cubeCorners   = new Float32Array(count * corners * 3)
  const indices = new Uint32Array(count * CUBE_TRIANGLE_INDICES.length)

  for (let i = 0; i < count; i++) {
    const src = i * 3
    for (let c = 0; c < corners; c++) {
      const dst = (i * corners + c) * 3
      cubePositions[dst]     = positions[src]
      cubePositions[dst + 1] = positions[src + 1]
      cubePositions[dst + 2] = positions[src + 2]
      cubeColors[dst]        = colors[src]
      cubeColors[dst + 1]    = colors[src + 1]
      cubeColors[dst + 2]    = colors[src + 2]
      const sign = CUBE_CORNER_SIGNS[c]
      cubeCorners[dst]     = sign[0]
      cubeCorners[dst + 1] = sign[1]
      cubeCorners[dst + 2] = sign[2]
    }
    const idxBase = i * CUBE_TRIANGLE_INDICES.length
    const vertBase = i * corners
    for (let k = 0; k < CUBE_TRIANGLE_INDICES.length; k++) {
      indices[idxBase + k] = vertBase + CUBE_TRIANGLE_INDICES[k]
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(cubePositions, 3))
  geometry.setAttribute('aColor',   new THREE.BufferAttribute(cubeColors,    3))
  geometry.setAttribute('aCorner',  new THREE.BufferAttribute(cubeCorners,   3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return geometry
}

export class VertexIdLayer extends IdLayerBase<THREE.Points | THREE.Mesh> {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean
  protected readonly primitiveNounPlural = 'vertices'

  private readonly cubePixels: number | undefined
  private material: THREE.ShaderMaterial

  constructor(registry: IdRegistry, _config?: VertexIdLayerConfig) {
    super(registry)
    this.name = _config?.name ?? VERTEX_LAYER_NAME
    this.priority = _config?.priority ?? 20
    this.zPolicy = _config?.zPolicy ?? 'no-depth'
    this.cubePixels = _config?.cubePixels
    this.material = buildVertexIdMaterial(this.cubePixels, _config?.depthBias)
  }

  // Screen-space cube size in pixels, or undefined when drawing flat points.
  getCubePixels(): number | undefined { return this.cubePixels }

  onBeforeRender(_width: number, height: number): void {
    const u = this.material.uniforms?.uViewportHeight
    if (u) u.value = height
  }

  registerBody(reg: VertexBodyRegistration): void {
    this.unregisterBody(reg.bodyKey)
    const { vertices, vertexQueries } = reg
    const count = vertices.length
    if (count === 0) return

    const positions = new Float32Array(count * 3)
    const colors    = new Float32Array(count * 3)
    const ids = this.primitiveIds(reg.bodyKey, reg.perPrimitivePickKeys)

    let written = 0
    for (let i = 0; i < count; i++) {
      const query = vertexQueries[i]
      if (query === undefined) continue
      // Keyed on the vertex's own index i, not on `written`: the pick key has to
      // match what Body3D recomputes from the registration's vertex list, which
      // includes the query-less vertices this loop skips.
      const [r, g, b] = ids.rgbFor(i, query)
      const v = vertices[i]
      const base = written * 3
      positions[base]     = v[0]
      positions[base + 1] = v[1]
      positions[base + 2] = v[2]
      colors[base]      = r
      colors[base + 1]  = g
      colors[base + 2]  = b
      written++
    }

    if (written === 0) return

    const finalPositions = written === count ? positions : positions.subarray(0, written * 3)
    const finalColors    = written === count ? colors    : colors.subarray(0, written * 3)

    const geometry = this.cubePixels === undefined
      ? buildPointGeometry(finalPositions, finalColors)
      : buildCubeGeometry(finalPositions, finalColors, written)

    const mesh = this.cubePixels === undefined
      ? new THREE.Points(geometry, this.material)
      : new THREE.Mesh(geometry, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.bodies.set(reg.bodyKey, { mesh, geometry, allocatedIds: ids.allocatedIds })
  }

  dispose(): void {
    this.disposeBodies()
    this.material.dispose()
  }
}
