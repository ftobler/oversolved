// PURE LOGIC -- no WASM, no Three.js. Unit tests for applyResizeCircle.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyResizeCircle, applyMoveEntity } from '@/utils/yamlMutations/sketch'

function docWithCircle(radius = 3): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'Sketch1',
      kind: 'sketch',
      entities: [{ id: 'circ1', kind: 'circle' }, { id: 'ln1', kind: 'line' }],
      initial: { circ1: [5, 5, radius], ln1: [0, 0, 10, 0] },
      constraints: [],
    }],
  }
}

describe('applyResizeCircle', () => {
  it('writes the radius param', () => {
    const doc = docWithCircle()
    applyResizeCircle(doc, 'Sketch1', 'circ1', 7.25)
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 7.25])
  })

  it('rejects a non-finite radius and leaves the doc untouched', () => {
    const doc = docWithCircle()
    applyResizeCircle(doc, 'Sketch1', 'circ1', NaN)
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
    applyResizeCircle(doc, 'Sketch1', 'circ1', Infinity)
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
  })

  it('rejects a non-positive radius', () => {
    const doc = docWithCircle()
    applyResizeCircle(doc, 'Sketch1', 'circ1', 0)
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
    applyResizeCircle(doc, 'Sketch1', 'circ1', -2)
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
  })

  it('adopts solvedGeometry before applying the radius', () => {
    // The solved frame moves the centre; the radius is then pinned on top.
    const doc = docWithCircle()
    applyResizeCircle(doc, 'Sketch1', 'circ1', 9, { circ1: [1, 2, 3], ln1: [0, 0, 10, 0] })
    expect(doc.features![0].initial!.circ1).toEqual([1, 2, 9])
  })

  it('ignores a non-circle entity', () => {
    const doc = docWithCircle()
    // Resizing a line is meaningless; the line params must be untouched.
    applyResizeCircle(doc, 'Sketch1', 'ln1', 7)
    expect(doc.features![0].initial!.ln1).toEqual([0, 0, 10, 0])
    // The circle is untouched too.
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
  })

  it('mirrors applyMoveEntity: translate leaves the radius untouched', () => {
    const doc = docWithCircle()
    applyMoveEntity(doc, 'Sketch1', 'circ1', [2, 0])
    expect(doc.features![0].initial!.circ1).toEqual([7, 5, 3])
  })
})
