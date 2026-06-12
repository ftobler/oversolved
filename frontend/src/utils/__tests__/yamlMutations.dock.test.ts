import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { applyAddConstraint, applyAddDock } from '@/utils/yamlMutations/sketch'

// Two circles held tangent; the dock materializes a point at the contact and
// ties it to the tangent host (lazy inferred materialization).
function makeSketchDoc(): PartDoc {
  const doc: PartDoc = {
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
        initial: { circA: [0, 0, 5], circB: [10, 0, 5] },
        constraints: [],
      },
    ],
  }
  applyAddConstraint(doc, 'Sketch1', 'tangent', ['entity:Sketch1:circA', 'entity:Sketch1:circB'])
  return doc
}

const sketch = (doc: PartDoc): PartFeature => doc.features![0]
const hostId = (doc: PartDoc) => sketch(doc).constraints!.find(c => c.kind === 'tangent')!.id
const docks = (doc: PartDoc) => (sketch(doc).constraints ?? []).filter(c => c.kind === 'dock')
const points = (doc: PartDoc) => sketch(doc).entities!.filter(e => e.kind === 'point')

describe('applyAddDock', () => {
  it('inserts a point at the contact and a dock constraint naming the host', () => {
    const doc = makeSketchDoc()
    applyAddDock(doc, 'Sketch1', [5, 0], hostId(doc))

    expect(points(doc)).toHaveLength(1)
    const pid = points(doc)[0].id
    expect(sketch(doc).initial![pid]).toEqual([5, 0])

    const ds = docks(doc)
    expect(ds).toHaveLength(1)
    expect(ds[0].host).toBe(hostId(doc))
    // The dock names the point as `xy`; the point ref carries the entity id.
    expect(JSON.stringify(ds[0].point)).toContain(pid)
  })

  it('is idempotent: a second dock on the same host reuses the point', () => {
    const doc = makeSketchDoc()
    applyAddDock(doc, 'Sketch1', [5, 0], hostId(doc))
    applyAddDock(doc, 'Sketch1', [5, 0], hostId(doc))
    expect(points(doc)).toHaveLength(1)
    expect(docks(doc)).toHaveLength(1)
  })

  it('is a no-op when the host constraint does not exist', () => {
    const doc = makeSketchDoc()
    applyAddDock(doc, 'Sketch1', [5, 0], 'no-such-constraint')
    expect(points(doc)).toHaveLength(0)
    expect(docks(doc)).toHaveLength(0)
  })
})
