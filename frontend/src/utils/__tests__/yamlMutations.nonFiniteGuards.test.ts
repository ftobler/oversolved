import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applySetPartTransparency, applySetPartMetalness, applySetPartRoughness, applySetPartTransmission,
  applySetRollback, applySetPlaneDefinitionField,
} from '@/utils/yamlMutations/partStyle'
import { applyAddExtrude, applyAddRevolve } from '@/utils/yamlMutations/featureDefs'
import {
  applyMoveEntity, applyAddEntity, applyAddEntityWithConstraint, applyAddNgon, applyAddOffset,
  applyMoveVertex, applyResizeCircle, applySetConstraintValue, applySetConstraintPos,
  applyAddPointAtIntersection,
} from '@/utils/yamlMutations/sketch'

// A non-finite number that reaches a mutation is always broken math upstream
// (an empty numeric input parsed, a drag frame divided by a zero extent, a
// malformed handle). What makes it worth a boundary gate rather than a
// downstream clean-up is that it PERSISTS: round(NaN) is NaN, Math.min/max
// propagate NaN, and YAML serializes it, so one bad frame poisons the document
// and every later solve seeded from it. Every mutation below refuses the write
// and warns; none throws, because these are all UI paths.

function sketchDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk',
      kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }],
  }
}

const feat = (doc: PartDoc) => doc.features![0]

describe('non-finite guards', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  // Math.max(0, Math.min(1, NaN)) is NaN, so the [0,1] clamp is not a gate.
  // A persisted NaN transparency reaches the material as an invalid opacity and
  // survives every reload.
  describe('clamped part style fields', () => {
    it.each([
      ['transparency', applySetPartTransparency],
      ['metalness', applySetPartMetalness],
      ['roughness', applySetPartRoughness],
      ['transmission', applySetPartTransmission],
    ])('%s refuses NaN rather than clamping it', (field, mutate) => {
      const doc: PartDoc = { version: 1, kind: 'part' }
      mutate(doc, 'body_ex1', NaN)
      expect(doc.part_style?.body_ex1?.[field as 'transparency']).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('leaves a previously stored value in place', () => {
      const doc: PartDoc = { version: 1, kind: 'part', part_style: { body_ex1: { transparency: 0.4 } } }
      applySetPartTransparency(doc, 'body_ex1', NaN)
      expect(doc.part_style!.body_ex1.transparency).toBe(0.4)
    })

    // +/-Infinity IS meaningfully clampable, unlike NaN, but it is still not a
    // number any slider produces: refuse it at the same gate.
    it('refuses Infinity rather than clamping it to 1', () => {
      const doc: PartDoc = { version: 1, kind: 'part' }
      applySetPartTransparency(doc, 'body_ex1', Infinity)
      expect(doc.part_style).toBeUndefined()
    })

    it('still writes a finite value', () => {
      const doc: PartDoc = { version: 1, kind: 'part' }
      applySetPartTransparency(doc, 'body_ex1', 0.25)
      expect(doc.part_style!.body_ex1.transparency).toBe(0.25)
    })
  })

  // setFeatureField already gates the EDIT path (set_extrude_field). The add
  // path wrote its required field straight into the def and skipped that gate,
  // so a NaN could only ever enter on creation. `distance`/`angle` are required
  // by the schema, so there is no field to drop: the whole feature is refused.
  describe('extrude / revolve creation', () => {
    it('applyAddExtrude refuses a non-finite distance and adds no feature', () => {
      const doc: PartDoc = { version: 1, kind: 'part', features: [] }
      applyAddExtrude(doc, 'ex1', 'Ext', '@sk1', NaN)
      expect(doc.features).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applyAddRevolve refuses a non-finite angle and adds no feature', () => {
      const doc: PartDoc = { version: 1, kind: 'part', features: [] }
      applyAddRevolve(doc, 'rv1', 'Rev', '@sk1', Infinity)
      expect(doc.features).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
    })

    // The refusal must not hide the sketch either: consuming a profile for a
    // feature that was never authored would leave the sketch invisible with
    // nothing built from it.
    it('does not hide the consumed sketch when the feature is refused', () => {
      const doc: PartDoc = {
        version: 1, kind: 'part',
        features: [{ id: 'sk1', kind: 'sketch', visible: true }],
      }
      applyAddExtrude(doc, 'ex1', 'Ext', '@sk1/area1', NaN)
      expect(doc.features![0].visible).toBe(true)
      expect(doc.features).toHaveLength(1)
    })

    it('still authors a feature for a finite value', () => {
      const doc: PartDoc = { version: 1, kind: 'part', features: [] }
      applyAddExtrude(doc, 'ex1', 'Ext', '@sk1', 10)
      expect(doc.features![0].extrude!.distance).toBe(10)
    })
  })

  describe('sketch entry points', () => {
    it('applyMoveEntity ignores a non-finite delta', () => {
      const doc = sketchDoc()
      applyMoveEntity(doc, 'sk', 'line1', [NaN, 3])
      expect(feat(doc).initial!.line1).toEqual([0, 0, 10, 0])
      expect(warnSpy).toHaveBeenCalled()
    })

    // The gate has to sit before adoptSolvedGeometry, or a bad delta would still
    // half-commit the drag by adopting the frame it came with.
    it('applyMoveEntity does not adopt the solved frame on a non-finite delta', () => {
      const doc = sketchDoc()
      applyMoveEntity(doc, 'sk', 'line1', [NaN, 3], { line1: [1, 1, 11, 1] })
      expect(feat(doc).initial!.line1).toEqual([0, 0, 10, 0])
    })

    it('applyAddEntity refuses a non-finite seed param', () => {
      const doc = sketchDoc()
      applyAddEntity(doc, 'sk', 'circle', [0, NaN, 5])
      expect(feat(doc).entities).toHaveLength(1)
      expect(Object.keys(feat(doc).initial!)).toEqual(['line1'])
      expect(warnSpy).toHaveBeenCalled()
    })

    // Refusing before the entity is pushed is what keeps the snap constraint
    // from being authored against an entity that does not exist.
    it('applyAddEntityWithConstraint authors neither entity nor constraint', () => {
      const doc = sketchDoc()
      applyAddEntityWithConstraint(
        doc, 'sk', 'line', [0, 0, Infinity, 0], 'start', 'vertex:sk:line1:end', 'coincident',
      )
      expect(feat(doc).entities).toHaveLength(1)
      expect(feat(doc).constraints).toHaveLength(0)
    })

    // `radius <= 0` was the only guard, and NaN fails every comparison, so a
    // non-finite corner slipped through and seeded NaN vertices for every side.
    it('applyAddNgon refuses a non-finite corner', () => {
      const doc = sketchDoc()
      applyAddNgon(doc, 'sk', [0, 0], [NaN, 0], 6)
      expect(feat(doc).entities).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalled()
    })

    // A non-finite side count collapses the push loop, which used to leave an
    // `ngon` constraint behind with no lines under it.
    it('applyAddNgon refuses a non-finite side count and leaves no orphan constraint', () => {
      const doc = sketchDoc()
      applyAddNgon(doc, 'sk', [0, 0], [10, 0], NaN)
      expect(feat(doc).entities).toHaveLength(1)
      expect(feat(doc).constraints).toHaveLength(0)
    })

    it('applyAddNgon still authors a real n-gon', () => {
      const doc = sketchDoc()
      applyAddNgon(doc, 'sk', [0, 0], [10, 0], 5)
      expect(feat(doc).entities!.filter(e => e.kind === 'line')).toHaveLength(6)  // line1 + 5
    })

    // offsetSeed only rejects a degenerate SOURCE; the distance was ungated, so
    // every clone plus its miter reconnection was seeded NaN.
    it('applyAddOffset refuses a non-finite distance', () => {
      const doc = sketchDoc()
      applyAddOffset(doc, 'sk', ['line1'], NaN)
      expect(feat(doc).entities).toHaveLength(1)
      expect(feat(doc).constraints).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  // Backfill: the gates below already reject non-finite input but lacked direct
  // reject + no-mutation tests (each paired with a finite positive control).
  describe('vertex / circle / constraint / rollback / intersection', () => {
    function circleDoc(): PartDoc {
      return {
        version: 1, kind: 'part',
        features: [{
          id: 'sk', kind: 'sketch',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 5] },
          constraints: [],
        }],
      }
    }

    function constraintDoc(): PartDoc {
      return {
        version: 1, kind: 'part',
        features: [{
          id: 'sk', kind: 'sketch',
          entities: [{ id: 'line1', kind: 'line' }],
          initial: { line1: [0, 0, 10, 0] },
          constraints: [{ id: 'd1', kind: 'distance', value: 10 }],
        }],
      }
    }

    it('applyMoveVertex ignores a non-finite drop and does not move the vertex', () => {
      const doc = sketchDoc()
      applyMoveVertex(doc, 'sk', 'line1', 'start', [NaN, 3])
      expect(feat(doc).initial!.line1).toEqual([0, 0, 10, 0])
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applyMoveVertex still moves the vertex for a finite drop', () => {
      const doc = sketchDoc()
      applyMoveVertex(doc, 'sk', 'line1', 'start', [5, 5])
      expect(feat(doc).initial!.line1).toEqual([5, 5, 10, 0])
    })

    it('applyResizeCircle ignores a non-finite radius and leaves the radius untouched', () => {
      const doc = circleDoc()
      applyResizeCircle(doc, 'sk', 'c1', NaN)
      expect(feat(doc).initial!.c1).toEqual([0, 0, 5])
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applyResizeCircle still resizes for a finite radius', () => {
      const doc = circleDoc()
      applyResizeCircle(doc, 'sk', 'c1', 3)
      expect(feat(doc).initial!.c1).toEqual([0, 0, 3])
    })

    it('applySetConstraintValue ignores a non-finite value and leaves the constraint untouched', () => {
      const doc = constraintDoc()
      applySetConstraintValue(doc, 'sk', 'd1', NaN)
      expect(feat(doc).constraints![0].value).toBe(10)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applySetConstraintValue still writes a finite value', () => {
      const doc = constraintDoc()
      applySetConstraintValue(doc, 'sk', 'd1', 7)
      expect(feat(doc).constraints![0].value).toBe(7)
    })

    it('applySetConstraintPos ignores a non-finite position and leaves the constraint untouched', () => {
      const doc = constraintDoc()
      applySetConstraintPos(doc, 'sk', 'd1', [NaN, 3])
      expect(feat(doc).constraints![0].pos).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applySetConstraintPos still writes a finite position', () => {
      const doc = constraintDoc()
      applySetConstraintPos(doc, 'sk', 'd1', [2, 2])
      expect(feat(doc).constraints![0].pos).toEqual([2, 2])
    })

    it('applySetRollback ignores a non-finite position and leaves rollback unset', () => {
      const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude' }] }
      applySetRollback(doc, Infinity)
      expect(doc.rollback).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applySetRollback still parks at a finite position', () => {
      const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude' }] }
      applySetRollback(doc, 0)
      expect(doc.rollback).toBe(0)
    })

    // A plane offset is written verbatim into the definition and persisted to
    // YAML, so a non-finite edit must not overwrite the last good offset.
    it('applySetPlaneDefinitionField ignores a non-finite value and leaves the definition untouched', () => {
      const doc: PartDoc = {
        version: 1, kind: 'part',
        features: [{ id: 'p1', kind: 'plane', definition: { mode: 'offset', offset: 5 } }],
      }
      applySetPlaneDefinitionField(doc, 'p1', 'offset', NaN)
      expect(feat(doc).definition!.offset).toBe(5)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applySetPlaneDefinitionField still writes a finite value', () => {
      const doc: PartDoc = {
        version: 1, kind: 'part',
        features: [{ id: 'p1', kind: 'plane', definition: { mode: 'offset' } }],
      }
      applySetPlaneDefinitionField(doc, 'p1', 'offset', 12)
      expect(feat(doc).definition!.offset).toBe(12)
    })

    it('applyAddPointAtIntersection ignores a non-finite location and adds no entity', () => {
      const doc = sketchDoc()
      const pid = applyAddPointAtIntersection(doc, 'sk', [NaN, NaN], ['line1'])
      expect(pid).toBeNull()
      expect(feat(doc).entities).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('applyAddPointAtIntersection still materializes a point for a finite location', () => {
      const doc = sketchDoc()
      const pid = applyAddPointAtIntersection(doc, 'sk', [4, 4], ['line1'])
      expect(pid).not.toBeNull()
      expect(feat(doc).entities).toHaveLength(2)
      expect(feat(doc).initial![pid!]).toEqual([4, 4])
    })
  })

  // The invariant behind all of the above: after any refused mutation the
  // document still serializes without a NaN, which YAML cannot represent
  // losslessly anyway.
  it('no refused mutation leaves a non-finite number in the document', () => {
    const doc = sketchDoc()
    applyMoveEntity(doc, 'sk', 'line1', [NaN, NaN])
    applyAddEntity(doc, 'sk', 'circle', [NaN, NaN, NaN])
    applyAddNgon(doc, 'sk', [0, 0], [NaN, NaN], 6)
    applyAddOffset(doc, 'sk', ['line1'], Infinity)
    for (const params of Object.values(feat(doc).initial!)) {
      expect(params.every(v => Number.isFinite(v))).toBe(true)
    }
    expect(JSON.stringify(doc)).not.toContain('null')  // JSON.stringify(NaN) is `null`
  })
})
