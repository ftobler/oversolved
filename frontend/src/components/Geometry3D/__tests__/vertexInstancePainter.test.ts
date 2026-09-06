import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { VertexInstancePainter, type InstanceTarget, type VertexList } from '@/components/Geometry3D/vertexInstancePainter'

/**
 * Body3D used to recompose one matrix per vertex, for both instanced vertex
 * meshes, on EVERY frame -- still camera, nothing hovered, no exceptions -- and
 * re-upload the whole instanceMatrix with it. On an imported body that is tens of
 * thousands of matrices per frame for a picture that did not change.
 *
 * The painter's contract is therefore "paint on change, and only on change", where
 * change includes the inputs a re-solve moves (a new vertices array) and not just
 * the camera scale.
 */

const VERTICES: VertexList = [[0, 0, 0], [1, 0, 0], [0, 2, 0]]
const HOVER = new THREE.Color('#ffffff')
const SELECTED = new THREE.Color('#ff8800')

describe('VertexInstancePainter', () => {
  it('paints on the first sync and skips an identical one', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()

    expect(painter.sync({ target, vertices: VERTICES, scale: 0.5 })).toBe(true)
    expect(target.matrices.size).toBe(3)
    expect(target.instanceMatrix.needsUpdate).toBe(true)

    target.reset()
    expect(painter.sync({ target, vertices: VERTICES, scale: 0.5 })).toBe(false)
    expect(target.matrices.size).toBe(0)
    expect(target.instanceMatrix.needsUpdate).toBe(false)
  })

  it('repaints when the camera scale moves', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    painter.sync({ target, vertices: VERTICES, scale: 0.5 })
    target.reset()

    expect(painter.sync({ target, vertices: VERTICES, scale: 0.6 })).toBe(true)
    expect(scaleOf(target, 0)).toBeCloseTo(0.6)
  })

  it('repaints at an unchanged scale when a re-solve hands new vertices', () => {
    // The guard must not be scale-only: a re-solve moves the vertices while the
    // camera sits still, and stale matrices would leave the markers behind.
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    painter.sync({ target, vertices: VERTICES, scale: 0.5 })
    target.reset()

    const moved: VertexList = [[9, 9, 9], [1, 0, 0], [0, 2, 0]]
    expect(painter.sync({ target, vertices: moved, scale: 0.5 })).toBe(true)
    expect(positionOf(target, 0)).toEqual([9, 9, 9])
  })

  it('repaints when the instanced mesh itself is replaced', () => {
    const painter = new VertexInstancePainter()
    painter.sync({ target: fakeTarget(), vertices: VERTICES, scale: 0.5 })

    const remounted = fakeTarget()
    expect(painter.sync({ target: remounted, vertices: VERTICES, scale: 0.5 })).toBe(true)
    expect(remounted.matrices.size).toBe(3)
  })

  it('colours the picked vertices and hides the rest', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()

    painter.sync({
      target, vertices: VERTICES, scale: 0.5,
      selected: [false, true, false],
      hovered: [true, false, false],
      selectedColor: SELECTED, hoveredColor: HOVER,
    })

    expect(target.colors.get(0)?.getHexString()).toBe(HOVER.getHexString())
    expect(target.colors.get(1)?.getHexString()).toBe(SELECTED.getHexString())
    expect(target.colors.has(2)).toBe(false)
    expect(scaleOf(target, 0)).toBeCloseTo(0.5)
    expect(scaleOf(target, 2)).toBe(0)  // neither picked: hidden
    expect(target.instanceColor?.needsUpdate).toBe(true)
  })

  it('selection outranks hover on the same vertex', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    painter.sync({
      target, vertices: VERTICES, scale: 0.5,
      selected: [true, false, false], hovered: [true, false, false],
      selectedColor: SELECTED, hoveredColor: HOVER,
    })
    expect(target.colors.get(0)?.getHexString()).toBe(SELECTED.getHexString())
  })

  it('repaints when the pick flags change identity at an unchanged scale', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    const paint = {
      target, vertices: VERTICES, scale: 0.5,
      selectedColor: SELECTED, hoveredColor: HOVER,
    }
    painter.sync({ ...paint, selected: null, hovered: [true, false, false] })
    target.reset()

    expect(painter.sync({ ...paint, selected: null, hovered: [false, true, false] })).toBe(true)
    expect(target.colors.get(1)?.getHexString()).toBe(HOVER.getHexString())
    expect(scaleOf(target, 0)).toBe(0)
  })

  it('repaints when the selected colour object changes identity at otherwise-identical inputs', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    const base = {
      target, vertices: VERTICES, scale: 0.5,
      selected: [true, false, false], hovered: null,
      hoveredColor: HOVER,
    }
    painter.sync({ ...base, selectedColor: new THREE.Color('#ff8800') })
    target.reset()
    expect(painter.sync({ ...base, selectedColor: new THREE.Color('#00ff88') })).toBe(true)
    expect(target.colors.get(0)?.getHexString()).toBe('00ff88')
  })

  it('repaints when the hovered colour object changes identity', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    const base = {
      target, vertices: VERTICES, scale: 0.5,
      selected: null, hovered: [true, false, false],
      selectedColor: SELECTED,
    }
    painter.sync({ ...base, hoveredColor: new THREE.Color('#111111') })
    target.reset()
    expect(painter.sync({ ...base, hoveredColor: new THREE.Color('#222222') })).toBe(true)
    expect(target.colors.get(0)?.getHexString()).toBe('222222')
  })

  it('still skips an identical sync when the colour objects are the same reference', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    const paint = {
      target, vertices: VERTICES, scale: 0.5,
      selected: [true, false, false] as boolean[], hovered: null,
      selectedColor: SELECTED, hoveredColor: HOVER,
    }
    painter.sync(paint)
    target.reset()
    expect(painter.sync(paint)).toBe(false)
  })

  it('leaves instanceColor alone on an unflagged pass', () => {
    const painter = new VertexInstancePainter()
    const target = fakeTarget()
    painter.sync({ target, vertices: VERTICES, scale: 0.5 })
    expect(target.colors.size).toBe(0)
    expect(target.instanceColor?.needsUpdate).toBe(false)
  })
})

interface FakeTarget extends InstanceTarget {
  matrices: Map<number, THREE.Matrix4>
  colors: Map<number, THREE.Color>
  instanceColor: { needsUpdate: boolean }
  reset(): void
}

function fakeTarget(): FakeTarget {
  return {
    matrices: new Map(),
    colors: new Map(),
    instanceMatrix: { needsUpdate: false },
    instanceColor: { needsUpdate: false },
    setMatrixAt(index: number, matrix: THREE.Matrix4) { this.matrices.set(index, matrix.clone()) },
    setColorAt(index: number, color: THREE.Color) { this.colors.set(index, color.clone()) },
    reset() {
      this.matrices.clear()
      this.colors.clear()
      this.instanceMatrix.needsUpdate = false
      this.instanceColor.needsUpdate = false
    },
  }
}

// Read the matrix elements directly rather than via `decompose`: the rotation is
// always identity here, so element 0 IS the x scale -- and decompose reports a
// zero-scale (hidden) matrix as scale 1.
function scaleOf(target: FakeTarget, index: number): number {
  return target.matrices.get(index)!.elements[0]
}

function positionOf(target: FakeTarget, index: number): number[] {
  return target.matrices.get(index)!.elements.slice(12, 15)
}
