import * as THREE from 'three'

/**
 * Per-frame instance writer for a body's vertex markers, with a change guard.
 *
 * A body's vertex POSITIONS are static; the instance matrices only move when the
 * screen-space scale changes (and, for the visible dots, when the pick flags do).
 * Recomposing them unconditionally cost one matrix compose per vertex plus a full
 * instanceMatrix re-upload on EVERY frame -- still camera, nothing hovered -- which
 * on an imported body of tens of thousands of vertices is a tax the whole viewport
 * pays whether or not anything is being picked.
 *
 * One painter per instanced mesh. It re-paints when any of its inputs changes
 * identity -- including the two colour objects it writes through `setColorAt` --
 * so a re-solve (new `vertices` array) or a remounted mesh repaints even at an
 * unchanged scale.
 */

/** The InstancedMesh surface a paint writes. Structural so tests need no GL. */
export interface InstanceTarget {
  setMatrixAt(index: number, matrix: THREE.Matrix4): void
  setColorAt(index: number, color: THREE.Color): void
  instanceMatrix: { needsUpdate: boolean }
  instanceColor?: { needsUpdate: boolean } | null
}

export type VertexList = ReadonlyArray<readonly [number, number, number]>

export interface VertexPaint {
  target: InstanceTarget
  vertices: VertexList
  // Uniform world-space scale for one marker (screen pixels -> world).
  scale: number
  /**
   * Per-vertex highlight flags. Omit both for a plain pass that scales every
   * vertex alike (the invisible hit spheres). With them, selection outranks
   * hover and a vertex in neither set is scaled to zero, i.e. hidden.
   */
  selected?: readonly boolean[] | null
  hovered?: readonly boolean[] | null
  selectedColor?: THREE.Color
  hoveredColor?: THREE.Color
}

const ZERO_SCALE = new THREE.Vector3(0, 0, 0)

export class VertexInstancePainter {
  private readonly position = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()  // identity
  private readonly scaleVec = new THREE.Vector3()
  private readonly matrix = new THREE.Matrix4()

  private target: InstanceTarget | null = null
  private vertices: VertexList | null = null
  private scale = -1
  private selected: readonly boolean[] | null | undefined = undefined
  private hovered: readonly boolean[] | null | undefined = undefined
  private selectedColor: THREE.Color | undefined = undefined
  private hoveredColor: THREE.Color | undefined = undefined

  // Write the instances if anything changed. Returns whether it painted.
  sync(paint: VertexPaint): boolean {
    if (!this.changed(paint)) return false
    const { target, vertices, scale, selected, hovered } = paint
    this.target = target
    this.vertices = vertices
    this.scale = scale
    this.selected = selected
    this.hovered = hovered
    this.selectedColor = paint.selectedColor
    this.hoveredColor = paint.hoveredColor

    const flagged = selected != null || hovered != null
    this.scaleVec.set(scale, scale, scale)
    for (let i = 0; i < vertices.length; i++) {
      const [x, y, z] = vertices[i]
      this.position.set(x, y, z)
      const color = flagged
        ? (selected?.[i] ? paint.selectedColor : hovered?.[i] ? paint.hoveredColor : undefined)
        : undefined
      // A flagged pass hides everything it has no colour for, so one marker can be
      // shown without the others popping up at full size.
      this.matrix.compose(this.position, this.rotation, flagged && !color ? ZERO_SCALE : this.scaleVec)
      target.setMatrixAt(i, this.matrix)
      if (color) target.setColorAt(i, color)
    }
    target.instanceMatrix.needsUpdate = true
    if (flagged && target.instanceColor) target.instanceColor.needsUpdate = true
    return true
  }

  private changed(paint: VertexPaint): boolean {
    return this.target !== paint.target
      || this.vertices !== paint.vertices
      || this.scale !== paint.scale
      || this.selected !== paint.selected
      || this.hovered !== paint.hovered
      || this.selectedColor !== paint.selectedColor
      || this.hoveredColor !== paint.hoveredColor
  }
}
