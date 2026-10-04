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

  // A dock's `point` survives a solve round-trip as the resolved `{entity, point}`
  // dict rather than the `$<eid>xy` wire string. Both forms name an entity id and
  // both can outlive it (the point deleted, the dock's own GC missed), so the
  // membership check has to cover the dict too -- otherwise the reuse path hands
  // back a dead id and the caller rewrites a constraint onto an entity that is
  // not in the sketch. Same rejection as the string form: null.
  it.each([
    ['dict form',   { entity: 'ghost', point: 'xy' }],
    ['string form', '$ghostxy'],
  ])('rejects an existing dock whose %s point names an unknown entity', (_name, point) => {
    const doc = makeSketchDoc()
    const host = hostId(doc)
    sketch(doc).constraints!.push({ id: 'c_dock_stale', kind: 'dock', point, host } as never)

    expect(applyAddDock(doc, 'Sketch1', [5, 0], host)).toBeNull()
    // The stale dock is reused-or-nothing: no second dock, no orphan point.
    expect(docks(doc)).toHaveLength(1)
    expect(points(doc)).toHaveLength(0)
  })

  it('reuses a dict-form point that DOES name a live entity', () => {
    const doc = makeSketchDoc()
    const host = hostId(doc)
    sketch(doc).entities!.push({ id: 'live', kind: 'point' })
    sketch(doc).initial!['live'] = [5, 0]
    sketch(doc).constraints!.push({
      id: 'c_dock_live', kind: 'dock', point: { entity: 'live', point: 'xy' }, host,
    } as never)

    expect(applyAddDock(doc, 'Sketch1', [5, 0], host)).toBe('live')
    expect(points(doc)).toHaveLength(1)
  })

  // The seed is persisted verbatim, so a degenerate host location must not reach
  // feature.initial as a NaN pose.
  it('refuses a non-finite contact location', () => {
    const doc = makeSketchDoc()
    expect(applyAddDock(doc, 'Sketch1', [NaN, 0], hostId(doc))).toBeNull()
    expect(points(doc)).toHaveLength(0)
    expect(docks(doc)).toHaveLength(0)
  })
})

const coincidents = (doc: PartDoc) => (sketch(doc).constraints ?? []).filter(c => c.kind === 'coincident')

describe('applyAddConstraint dock interception (materialize-on-reference)', () => {
  // When the dock exists but its point id cannot be resolved (_dockPointId
  // returns null because the wire ref names an entity that is gone), applyAddDock
  // reuses nothing and returns null. The pick is dropped rather than authored:
  // persisting the raw handle would leave a literal `$dock:` ref the solver can
  // never resolve.
  it('an existing dock with an unresolvable point authors no constraint', () => {
    const doc = makeSketchDoc()
    const host = hostId(doc)
    sketch(doc).constraints!.push({
      id: 'c_dock_stale', kind: 'dock', point: '$ghostxy', host,
    } as never)
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [9, 9]

    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:free:xy',
      `dock:Sketch1:${host}`,
    ])

    // No second dock, no materialized contact point, and no authored constraint.
    expect(docks(doc)).toHaveLength(1)
    expect(points(doc)).toHaveLength(1)
    expect(coincidents(doc)).toHaveLength(0)
  })

  it('a dock handle that resolves still authors the constraint', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [9, 9]

    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:free:xy',
      `dock:Sketch1:${hostId(doc)}`,
    ])

    expect(docks(doc)).toHaveLength(1)
    expect(coincidents(doc)).toHaveLength(1)
  })

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

  // parseFloat on a malformed token yields NaN, which round() used to carry
  // straight into the materialized point's seed -- a NaN pose in the document.
  it('a malformed isect: coordinate bails instead of seeding NaN', () => {
    const doc = makeSketchDoc()
    sketch(doc).entities!.push({ id: 'free', kind: 'point' })
    sketch(doc).initial!['free'] = [3, 3]
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:free:xy',
      'isect:Sketch1:abc:def',
    ])
    // Nothing materialized, and every stored param stayed finite.
    expect(points(doc)).toHaveLength(1)
    for (const params of Object.values(sketch(doc).initial!)) {
      expect(params.every(Number.isFinite)).toBe(true)
    }
    expect(sketch(doc).initial!['free']).toEqual([3, 3])
  })
})
