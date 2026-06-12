import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { applyAddConstraint, applyAddDock } from '@/utils/yamlMutations/sketch'
import { mutationHandlers } from '@/hooks/mutationDispatch'

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

const coincidents = (doc: PartDoc) => (sketch(doc).constraints ?? []).filter(c => c.kind === 'coincident')

describe('applyAddConstraint dock interception (materialize-on-reference)', () => {
  it('a dock: handle target materializes the point and rewrites the constraint to it', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [9, 9]

    // Author coincident(freePoint, dockHandle). Naming the dock makes it real.
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:free:xy',
      `dock:Sketch1:${hostId(doc)}`,
    ])

    // The dock materialized: a new point + a dock constraint exist.
    expect(points(doc)).toHaveLength(2)  // 'free' plus the materialized contact
    expect(docks(doc)).toHaveLength(1)
    const matId = docks(doc)[0].host === hostId(doc)
      ? points(doc).find(p => p.id !== 'free')!.id
      : null
    expect(matId).not.toBeNull()

    // The authored coincident now references the materialized point, not the handle.
    const cs = coincidents(doc)
    expect(cs).toHaveLength(1)
    const blob = JSON.stringify(cs[0])
    expect(blob).toContain('free')
    expect(blob).toContain(matId!)
    expect(blob).not.toContain('dock:')
  })

  it('two constraints naming the same dock share one materialized point (idempotent)', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' })
    sketch(doc).initial!['p1'] = [1, 1]
    sketch(doc).initial!['p2'] = [2, 2]
    const handle = `dock:Sketch1:${hostId(doc)}`
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:p1:xy', handle])
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:p2:xy', handle])
    // p1, p2, plus exactly ONE materialized contact point.
    expect(points(doc)).toHaveLength(3)
    expect(docks(doc)).toHaveLength(1)
  })
})

describe('add_constraint dispatch with a dock handle target (click-pick path)', () => {
  it('a selection containing a dock handle materializes through the mutation dispatch', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [7, 7]
    // This mirrors ConstraintTool: targets = Array.from(normalSelection), where one
    // selected item is the dock marker's `dock:<fid>:<hostId>` handle.
    mutationHandlers.add_constraint(doc, {
      type: 'add_constraint',
      featureId: 'Sketch1',
      kind: 'coincident',
      targets: ['vertex:Sketch1:free:xy', `dock:Sketch1:${hostId(doc)}`],
    })
    // The dock materialized and the coincident references the real point.
    expect(points(doc)).toHaveLength(2)
    expect(docks(doc)).toHaveLength(1)
    const cs = (sketch(doc).constraints ?? []).filter(c => c.kind === 'coincident')
    expect(cs).toHaveLength(1)
    expect(JSON.stringify(cs[0])).not.toContain('dock:')
  })
})

describe('applyAddConstraint isect handle interception (free intersection)', () => {
  it('an isect: handle materializes a point pinned to its baked-in curves', () => {
    const doc = makeSketchDoc()  // circA, circB + tangent (curves available)
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [3, 3]
    // Handle as the pick layer would emit it: isect:<fid>:<x>:<y>:<curveA>:<curveB>.
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:free:xy',
      'isect:Sketch1:5:0:circA:circB',
    ])
    // A materialized point sits at the intersection, pinned to both curves.
    expect(points(doc)).toHaveLength(2)  // free + materialized
    const mat = points(doc).find(p => p.id !== 'free')!.id
    expect(sketch(doc).initial![mat]).toEqual([5, 0])
    // Two coincident-to-locus pins (to circA/circB) plus the authored coincident.
    const coincidents = (sketch(doc).constraints ?? []).filter(c => c.kind === 'coincident')
    expect(coincidents.length).toBe(3)
    expect(JSON.stringify(coincidents)).not.toContain('isect:')
  })
})
