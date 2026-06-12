import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { applyAddPointAtIntersection } from '@/utils/yamlMutations/sketch'

// Two circles plus a stray line; the materialize action pins a new point to the
// two curves that meet at the contact via coincident-to-locus constraints.
function makeSketchDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'Sketch1',
        kind: 'sketch',
        entities: [
          { id: 'circA', kind: 'circle' },
          { id: 'circB', kind: 'circle' },
        ],
        initial: {
          circA: [0, 0, 5],
          circB: [10, 0, 5],  // externally tangent to circA at (5, 0)
        },
        constraints: [],
      },
    ],
  }
}

const sketch = (doc: PartDoc): PartFeature => doc.features![0]
const coincidents = (doc: PartDoc) => (sketch(doc).constraints ?? []).filter(c => c.kind === 'coincident')
const newPointId = (doc: PartDoc) => sketch(doc).entities!.find(e => e.kind === 'point')!.id

describe('applyAddPointAtIntersection', () => {
  it('materializes a point at the contact, pinned to both curves', () => {
    const doc = makeSketchDoc()
    applyAddPointAtIntersection(doc, 'Sketch1', [5, 0], ['circA', 'circB'])

    const pid = newPointId(doc)
    expect(sketch(doc).initial![pid]).toEqual([5, 0])

    const cs = coincidents(doc)
    expect(cs.length).toBe(2)
    // Each coincident bonds the new point's xy vertex to one circle's locus.
    const blob = cs.map(c => JSON.stringify(c))
    expect(blob.every(s => s.includes(pid))).toBe(true)
    expect(blob.some(s => s.includes('circA'))).toBe(true)
    expect(blob.some(s => s.includes('circB'))).toBe(true)
  })

  it('dedupes repeated curves to a single locus each', () => {
    const doc = makeSketchDoc()
    applyAddPointAtIntersection(doc, 'Sketch1', [5, 0], ['circA', 'circA', 'circB'])
    expect(coincidents(doc).length).toBe(2)
  })

  it('with fewer than two distinct curves leaves a free point (no constraint)', () => {
    const doc = makeSketchDoc()
    applyAddPointAtIntersection(doc, 'Sketch1', [5, 0], ['circA'])
    expect(coincidents(doc).length).toBe(0)
    // The point entity is still created so the click is not a no-op.
    expect(sketch(doc).entities!.some(e => e.kind === 'point')).toBe(true)
  })

  it('ignores point-kind refs (a point has no locus to lie on)', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'p0', kind: 'point' })
    sketch(doc).initial!['p0'] = [1, 1]
    applyAddPointAtIntersection(doc, 'Sketch1', [5, 0], ['circA', 'p0'])
    // Only circA is a usable locus -> below the 2-locus threshold -> free point.
    expect(coincidents(doc).length).toBe(0)
  })
})
