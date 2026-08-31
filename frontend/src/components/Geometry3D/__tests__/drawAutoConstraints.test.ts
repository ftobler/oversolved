import { describe, it, expect } from 'vitest'
import {
  snappableVertexAt,
  snappablePathAt,
  resolveInsertSnap,
  createInsertionHelper,
  insertCoincidentPoint,
  insertAxisConstraint,
  carriedSnapFields,
} from '@/components/Geometry3D/drawAutoConstraints'
import type { Entity } from '@/types/cad'
import type { DrawSnapState } from '@/components/Geometry3D/drawAutoConstraints'
import { computeDrawClick } from '@/components/Geometry3D/drawLogic'

const FEATURE = 'S1'
let idCounter = 0
const newId = () => `E${++idCounter}`

const emptySnap = (): DrawSnapState => ({
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredSelectionId: null,
  drawSnapRefs: [],
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
})

const onVertex = (id: string, at: [number, number]): DrawSnapState => ({
  ...emptySnap(),
  hoveredVertexId: id,
  hoveredVertexPosition: at,
  hoveredSnapKind: 'vertex',
})

const LINE: Record<string, Entity> = {
  L1: { start: [0, 0], end: [10, 0] } as Entity,
}
const onPath = (entityId: string): DrawSnapState => ({
  ...emptySnap(),
  hoveredSelectionId: `entity:${FEATURE}:${entityId}`,
})

describe('snappableVertexAt', () => {
  it('answers with the vertex when the click landed on it', () => {
    expect(snappableVertexAt(onVertex('vertex:S1:V1:end', [4, 0]), 4, 0)).toBe('vertex:S1:V1:end')
  })

  it('answers null for a published position the click did not land on', () => {
    expect(snappableVertexAt(onVertex('vertex:S1:V1:end', [4, 0]), 9, 9)).toBeNull()
  })

  it('falls back to the id/kind pair when the hover published no position', () => {
    const snap = emptySnap()
    snap.hoveredVertexId = 'vertex:S1:V1:end'
    snap.hoveredSnapKind = 'vertex'
    expect(snappableVertexAt(snap, 4, 0)).toBe('vertex:S1:V1:end')
  })

  it('answers null on an empty hover', () => {
    expect(snappableVertexAt(emptySnap(), 4, 0)).toBeNull()
  })
})

describe('snappablePathAt', () => {
  it('answers with the curve and the foot of the cursor on it', () => {
    expect(snappablePathAt(onPath('L1'), [4, 3], { sketch: LINE }))
      .toEqual({ entityRef: 'entity:S1:L1', at: [4, 0] })
  })

  it('answers null for a hover id that resolves to no entity', () => {
    expect(snappablePathAt(onPath('surface'), [4, 3], { sketch: LINE })).toBeNull()
  })

  it('answers null for a B-rep query string, which is not an entity ref', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:flatface'
    expect(snappablePathAt(snap, [4, 3], { sketch: LINE })).toBeNull()
  })

  it('answers null for a kind with no foot, e.g. a spline', () => {
    const spline: Record<string, Entity> = {
      S: { p1: [0, 0], p2: [1, 1], p3: [2, 1], p4: [3, 0] } as Entity,
    }
    expect(snappablePathAt(onPath('S'), [1, 1], { sketch: spline })).toBeNull()
  })

  it('finds a curve in another sketch too', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = 'entity:S2:L9'
    expect(snappablePathAt(snap, [4, 3], { otherSketches: { S2: { L9: LINE.L1 } } }))
      .toEqual({ entityRef: 'entity:S2:L9', at: [4, 0] })
  })
})

describe('resolveInsertSnap', () => {
  it('reads a vertex hover as a coincident against that vertex', () => {
    expect(resolveInsertSnap(onVertex('vertex:S1:V1:end', [4, 0]), [4, 0]))
      .toEqual({ kind: 'coincident', vertexId: 'vertex:S1:V1:end' })
  })

  it('reads a curve hover as a point on that path', () => {
    expect(resolveInsertSnap(onPath('L1'), [4, 3], { sketch: LINE }))
      .toEqual({ kind: 'point_on_path', entityRef: 'entity:S1:L1', at: [4, 0] })
  })

  it('lets a named vertex win over the curve it sits on', () => {
    const snap = { ...onVertex('vertex:S1:L1:end', [10, 0]), hoveredSelectionId: 'entity:S1:L1' }
    expect(resolveInsertSnap(snap, [10, 0], { sketch: LINE }))
      .toEqual({ kind: 'coincident', vertexId: 'vertex:S1:L1:end' })
  })

  it('reads a kinda_horizontal alignment as a horizontal, naming no element', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 5]
    snap.alignmentSnapKind = 'kinda_horizontal'
    expect(resolveInsertSnap(snap, [7, 5])).toEqual({ kind: 'horizontal' })
  })

  it('lets the alignment win over a vertex hover, as the point placement does', () => {
    const snap = onVertex('vertex:S1:V1:end', [4, 0])
    snap.alignmentSnapPoint = [0, 5]
    snap.alignmentSnapKind = 'kinda_vertical'
    expect(resolveInsertSnap(snap, [0, 3])).toEqual({ kind: 'vertical' })
  })
})

describe('insertionHelper', () => {
  it('answers the point question for a vertex snap and nothing else', () => {
    const helper = createInsertionHelper()
    helper.update(onVertex('vertex:S1:V1:end', [4, 0]), [4, 0])
    expect(helper.foundSnappablePoint()).toBe(true)
    expect(helper.foundSnappablePath()).toBe(false)
    expect(helper.foundHorizontal()).toBe(false)
    expect(helper.foundVertical()).toBe(false)
    expect(helper.getSnappedElement()).toBe('vertex:S1:V1:end')
  })

  it('answers the path question for a curve snap, and lands the point on it', () => {
    const helper = createInsertionHelper({ sketch: LINE })
    helper.update(onPath('L1'), [4, 3])
    expect(helper.foundSnappablePath()).toBe(true)
    expect(helper.foundSnappablePoint()).toBe(false)
    expect(helper.getSnappedElement()).toBe('entity:S1:L1')
    expect(helper.getPoint()).toEqual([4, 0])
  })

  it('answers the horizontal question for an alignment snap, naming no element', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 5]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const helper = createInsertionHelper()
    helper.update(snap, [7, 9])
    expect(helper.foundHorizontal()).toBe(true)
    expect(helper.foundSnappablePoint()).toBe(false)
    expect(helper.getSnappedElement()).toBeNull()
    expect(helper.getPoint()).toEqual([7, 5])
  })

  it('answers nothing before update, and forgets the last hover on re-update', () => {
    const helper = createInsertionHelper()
    expect(helper.foundSnappablePoint()).toBe(false)
    expect(helper.current()).toBeNull()
    helper.update(onVertex('vertex:S1:V1:end', [4, 0]), [4, 0])
    expect(helper.foundSnappablePoint()).toBe(true)
    helper.update(emptySnap(), [4, 0])
    expect(helper.foundSnappablePoint()).toBe(false)
    expect(helper.getSnappedElement()).toBeNull()
  })
})

describe('insert primitives', () => {
  it('insertCoincidentPoint authors a point pair', () => {
    expect(insertCoincidentPoint('vertex:S1:V1:end',
      { featureId: FEATURE, vertexRef: 'vertex:S1:E4:center', entityRef: 'entity:S1:E4' }))
      .toEqual([{ type: 'add_constraint', featureId: FEATURE, kind: 'coincident',
        targets: ['vertex:S1:E4:center', 'vertex:S1:V1:end'] }])
  })

  it('insertCoincidentPoint authors the locus form against a whole entity', () => {
    expect(insertCoincidentPoint('entity:S1:L1', { featureId: FEATURE, vertexRef: 'vertex:S1:E4:center' }))
      .toEqual([{ type: 'add_constraint', featureId: FEATURE, kind: 'coincident',
        targets: ['vertex:S1:E4:center', 'entity:S1:L1'] }])
  })

  it('insertAxisConstraint authors the single-target form', () => {
    expect(insertAxisConstraint('horizontal',
      { featureId: FEATURE, vertexRef: 'vertex:S1:E4:end', entityRef: 'entity:S1:E4' }))
      .toEqual([{ type: 'add_constraint', featureId: FEATURE, kind: 'horizontal',
        targets: ['entity:S1:E4'] }])
  })

  it('authors nothing when the entity being inserted has no ref for that snap', () => {
    expect(insertAxisConstraint('horizontal', { featureId: FEATURE, vertexRef: 'vertex:S1:E4:xy' }))
      .toEqual([])
    expect(insertCoincidentPoint('vertex:S1:V1:end', { featureId: FEATURE, entityRef: 'entity:S1:E4' }))
      .toEqual([])
  })

  it('authors nothing when no element was snapped', () => {
    expect(insertCoincidentPoint(null, { featureId: FEATURE, vertexRef: 'vertex:S1:E4:end' }))
      .toEqual([])
  })

  it('carriedSnapFields tells a vertex ref from a curve ref by its own prefix', () => {
    expect(carriedSnapFields('vertex:S1:L1:end')).toEqual({ snapVertexId: 'vertex:S1:L1:end' })
    expect(carriedSnapFields('entity:S1:L1')).toEqual({ snapEntityRef: 'entity:S1:L1' })
  })
})

describe('auto-inserted constraints per draw tool', () => {
  it('point: a placement on an existing vertex is pinned to it', () => {
    const result = computeDrawClick('point', [], [4, 0], onVertex('vertex:S1:V1:end', [4, 0]), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.kind).toBe('point')
      expect(m.vertexKey).toBe('xy')
      expect(m.snapVertexId).toBe('vertex:S1:V1:end')
      expect(m.constraintKind).toBe('coincident')
    }
  })

  it('point: a placement on a curve is pinned onto the curve', () => {
    const result = computeDrawClick('point', [], [4, 3], onPath('L1'), FEATURE, newId, LINE)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.snapEntityRef).toBe('entity:S1:L1')
      expect(m.snapVertexId).toBeUndefined()
      expect(m.params).toEqual([4, 0])
    }
  })

  it('point: a free placement stays a free point', () => {
    const result = computeDrawClick('point', [], [4, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations[0].type).toBe('add_entity')
  })

  it('point: an alignment snap authors no constraint, a point has no axis', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 5]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const result = computeDrawClick('point', [], [7, 5], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
  })

  it('circle: a centre click on a curve carries that curve to the commit', () => {
    const first = computeDrawClick('circle', [], [4, 3], onPath('L1'), FEATURE, newId, LINE)
    expect(first.nextDrawSnap).toEqual({ refs: ['entity:S1:L1'] })
    expect(first.nextDrawPoints).toEqual([[4, 0]])

    const snap = { ...emptySnap(), drawSnapRefs: ['entity:S1:L1'] }
    const commit = computeDrawClick('circle', [[4, 0]], [7, 0], snap, FEATURE, newId, LINE)
    const m = commit.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.vertexKey).toBe('center')
      expect(m.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('circle: a centre click on a vertex carries that vertex to the commit', () => {
    const first = computeDrawClick('circle', [], [4, 0], onVertex('vertex:S1:V1:end', [4, 0]), FEATURE, newId)
    expect(first.nextDrawSnap).toEqual({ refs: ['vertex:S1:V1:end'] })

    const snap = { ...emptySnap(), drawSnapRefs: ['vertex:S1:V1:end'] }
    const commit = computeDrawClick('circle', [[4, 0]], [7, 0], snap, FEATURE, newId)
    const m = commit.mutations[0]
    if (m.type === 'add_entity_with_constraint') {
      expect(m.vertexKey).toBe('center')
      expect(m.snapVertexId).toBe('vertex:S1:V1:end')
    }
  })

  it('circle: a centre click the alignment moved off the vertex carries nothing', () => {
    const snap = onVertex('vertex:S1:V1:end', [4, 0])
    snap.alignmentSnapPoint = [0, 5]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const first = computeDrawClick('circle', [], [4, 0], snap, FEATURE, newId)
    expect(first.nextDrawPoints).toEqual([[4, 5]])
    expect(first.nextDrawSnap).toEqual({ refs: [null] })
  })

  it('ellipse: a centre click on a curve carries that curve to the commit', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['entity:S1:L1'] }
    const commit = computeDrawClick('ellipse', [[4, 0]], [7, 0], snap, FEATURE, newId, LINE)
    const m = commit.mutations[0]
    if (m.type === 'add_entity_with_constraint') {
      expect(m.kind).toBe('ellipse')
      expect(m.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('spline: the closing click on a vertex pins the spline end to it', () => {
    const snap = onVertex('vertex:S1:V1:end', [4, 0])
    const result = computeDrawClick('spline', [[0, 0], [1, 3], [3, 3]], [4, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(2)
    const add = result.mutations[0]
    expect(add.type).toBe('add_entity')
    const entityId = add.type === 'add_entity' ? add.entityId : undefined
    expect(entityId).toBeTruthy()
    expect(result.mutations[1]).toEqual({
      type: 'add_constraint', featureId: FEATURE, kind: 'coincident',
      targets: [`vertex:${FEATURE}:${entityId}:end`, 'vertex:S1:V1:end'],
    })
  })

  it('spline: both ends on the same element author the start coincident only', () => {
    const snap = onVertex('vertex:S1:V1:end', [4, 0])
    snap.drawSnapRefs = ['vertex:S1:V1:end']
    const result = computeDrawClick('spline', [[0, 0], [1, 3], [3, 3]], [4, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity_with_constraint')
  })

  it('line: the end snap still authors coincident, unchanged by the extraction', () => {
    const snap = onVertex('vertex:S1:V1:end', [4, 0])
    const result = computeDrawClick('line', [[0, 0]], [4, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(2)
    expect(result.mutations[1].type).toBe('add_constraint')
    if (result.mutations[1].type === 'add_constraint') {
      expect(result.mutations[1].kind).toBe('coincident')
    }
  })

  it('line: an end click on a curve pins that end onto the curve', () => {
    const result = computeDrawClick('line', [[0, 5]], [4, 3], onPath('L1'), FEATURE, newId, LINE)
    expect(result.mutations).toHaveLength(2)
    const add = result.mutations[0]
    const lineId = add.type === 'add_entity' ? add.entityId : undefined
    if (add.type === 'add_entity') expect(add.params).toEqual([0, 5, 4, 0])
    expect(result.mutations[1]).toEqual({
      type: 'add_constraint', featureId: FEATURE, kind: 'coincident',
      targets: [`vertex:${FEATURE}:${lineId}:end`, 'entity:S1:L1'],
    })
  })

  it('line: a chain continues from its own end vertex, never from the curve', () => {
    const result = computeDrawClick('line', [[0, 5]], [4, 3], onPath('L1'), FEATURE, newId, LINE)
    const add = result.mutations[0]
    const lineId = add.type === 'add_entity' ? add.entityId : undefined
    expect(result.nextDrawSnap?.refs.at(-1)).toBe(`vertex:${FEATURE}:${lineId}:end`)
  })

  it('line: a start click on a curve seeds the segment onto it', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['entity:S1:L1'] }
    const result = computeDrawClick('line', [[4, 0]], [8, 6], snap, FEATURE, newId, LINE)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.vertexKey).toBe('start')
      expect(m.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('line: an alignment end snap still authors the axis constraint on the segment', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 0]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const result = computeDrawClick('line', [[0, 0]], [4, 3], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(2)
    if (result.mutations[1].type === 'add_constraint') {
      expect(result.mutations[1].kind).toBe('horizontal')
      expect(result.mutations[1].targets).toHaveLength(1)
    }
  })
})

describe('arc tool auto constraints', () => {
  // Both ends are clicked before the arc exists, so each one's snap has to
  // survive in the carried list until the third click creates the entity.
  it('pins the first clicked end to the vertex it landed on', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['vertex:S1:V1:end'] }
    const result = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], snap, FEATURE, newId)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.kind).toBe('arc')
      expect(m.snapVertexId).toBe('vertex:S1:V1:end')
      expect(m.constraintKind).toBe('coincident')
    }
  })

  it('pins the first clicked end onto a curve it landed on', () => {
    const first = computeDrawClick('arc', [], [4, 3], onPath('L1'), FEATURE, newId, LINE)
    expect(first.nextDrawSnap).toEqual({ refs: ['entity:S1:L1'] })
    expect(first.nextDrawPoints).toEqual([[4, 0]])

    const snap = { ...emptySnap(), drawSnapRefs: ['entity:S1:L1'] }
    const result = computeDrawClick('arc', [[4, 0], [10, 0]], [7, 3], snap, FEATURE, newId, LINE)
    const m = result.mutations[0]
    if (m.type === 'add_entity_with_constraint') {
      expect(m.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('carries the second click snap through to the commit', () => {
    const second = computeDrawClick('arc', [[0, 0]], [10, 0], onVertex('vertex:S1:V2:start', [10, 0]), FEATURE, newId)
    expect(second.nextDrawSnap).toEqual({ refs: [null, 'vertex:S1:V2:start'] })

    const snap = { ...emptySnap(), drawSnapRefs: [null, 'vertex:S1:V2:start'] }
    const result = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(2)
    expect(result.mutations[0].type).toBe('add_entity')
    expect(result.mutations[1].type).toBe('add_constraint')
  })

  it('follows each end across the start/end swap the bulge decides', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['vertex:S1:V1:end', 'vertex:S1:V2:start'] }
    // Bulge above the chord: the CCW sweep runs from the second click, so the
    // first clicked point is the arc's `end`.
    const above = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], snap, FEATURE, newId)
    const aboveSeed = above.mutations[0]
    expect(aboveSeed.type === 'add_entity_with_constraint' && aboveSeed.vertexKey).toBe('end')

    // Bulge below the chord: the sweep runs the other way and the same click is
    // now the arc's `start`.
    const below = computeDrawClick('arc', [[0, 0], [10, 0]], [5, -5], snap, FEATURE, newId)
    const belowSeed = below.mutations[0]
    expect(belowSeed.type === 'add_entity_with_constraint' && belowSeed.vertexKey).toBe('start')
  })

  it('the second constraint names the other vertex key', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['vertex:S1:V1:end', 'vertex:S1:V2:start'] }
    const result = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], snap, FEATURE, newId)
    const seed = result.mutations[0]
    const arcId = seed.type === 'add_entity_with_constraint' ? seed.entityId : undefined
    expect(result.mutations[1]).toEqual({
      type: 'add_constraint', featureId: FEATURE, kind: 'coincident',
      targets: [`vertex:${FEATURE}:${arcId}:start`, 'vertex:S1:V2:start'],
    })
  })

  it('an unsnapped arc is still a plain add_entity', () => {
    const result = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
  })

  it('three collinear points still commit nothing', () => {
    const snap = { ...emptySnap(), drawSnapRefs: ['vertex:S1:V1:end'] }
    const result = computeDrawClick('arc', [[0, 0], [5, 0]], [10, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.gestureComplete).toBe(false)
  })
})
