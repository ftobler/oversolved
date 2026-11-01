import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddExtrude,
  applyAddRevolve,
  applySetExtrudeField,
  applySetHelixField,
  applySetHoleField,
  applyAddArray,
  applyAddHole,
} from '@/utils/yamlMutations'
import { featureAt, featureById } from '@/testing/featureAccess'

// One storage precision for the document's numbers. The sketch mutators persist
// their seeds through round (helpers.ts, 1e-6), so a drag-authored 0.351324026
// landed as 0.351324 in a sketch seed but verbatim in an extrude distance: the
// same authored quantity spelled two ways in one document. These tests pin that
// a feature numeric write crosses the same boundary as a sketch seed.
const MESSY = 0.351324026
const MESSY_ROUNDED = 0.351324

const extrude0 = (doc: PartDoc) => featureAt(doc, 0, 'extrude').extrude
const revolve0 = (doc: PartDoc) => featureAt(doc, 0, 'revolve').revolve
const helix0 = (doc: PartDoc) => featureAt(doc, 0, 'helix').helix
const hole0 = (doc: PartDoc) => featureAt(doc, 0, 'hole').hole
const array0 = (doc: PartDoc) => featureAt(doc, 0, 'array').array

describe('feature value rounding', () => {
  it('applyAddExtrude rounds its distance like a sketch seed', () => {
    const doc: PartDoc = { features: [] }
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', MESSY)
    expect(extrude0(doc).distance).toBe(MESSY_ROUNDED)
  })

  it('applyAddRevolve rounds its angle like a sketch seed', () => {
    const doc: PartDoc = { features: [] }
    applyAddRevolve(doc, 'rv1', undefined, '$sk1', MESSY)
    expect(revolve0(doc).angle).toBe(MESSY_ROUNDED)
  })

  it('a setter path rounds the stored value', () => {
    const doc: PartDoc = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 10 } }] }
    applySetExtrudeField(doc, 'ex1', 'distance', MESSY)
    expect(extrude0(doc).distance).toBe(MESSY_ROUNDED)
  })

  it('an inline add field lands rounded through the setter funnel', () => {
    const doc: PartDoc = { features: [] }
    applyAddArray(doc, 'ar1', undefined, { pitch_x: MESSY })
    expect(array0(doc).pitch_x).toBe(MESSY_ROUNDED)
  })

  it('a one-call add carries the rounded field too', () => {
    const doc: PartDoc = { features: [] }
    applyAddHole(doc, 'ho1', undefined, { depth: MESSY })
    expect(hole0(doc).depth).toBe(MESSY_ROUNDED)
  })

  // The round must stay invisible for a clean authored value: a re-spelled 25.7
  // would move every save-identity and checkpoint-hash comparison that reads
  // round as a change.
  it('leaves a clean value byte-identical', () => {
    const doc: PartDoc = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } }] }
    applySetExtrudeField(doc, 'ex1', 'distance', 25.7)
    expect(extrude0(doc).distance).toBe(25.7)
    applySetExtrudeField(doc, 'ex1', 'distance', 0.1 + 0.2)
    expect(extrude0(doc).distance).toBe(0.3)  // the round also cleans f64 noise out of stored docs
  })

  // NumberOrExpr fields may hold a string expression; only a numeric write is
  // a number to round, and an expression must reach the evaluator untouched.
  it('leaves an expression string untouched', () => {
    const doc: PartDoc = { features: [{ id: 'hx1', kind: 'helix', helix: {} }] }
    applySetHelixField(doc, 'hx1', 'pitch', 'width * 0.351324026')
    expect(helix0(doc).pitch).toBe('width * 0.351324026')
  })

  // The finiteness gate beside the round must keep refusing: rounding a NaN
  // into storage is the exact poisoning the guards test already refuses.
  it('keeps refusing a non-finite value beside the round', () => {
    const doc: PartDoc = { features: [{ id: 'ho1', kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20 } }] }
    applySetHoleField(doc, 'ho1', 'depth', NaN)
    expect(hole0(doc).depth).toBe(20)
  })

  // The sketch side of the invariant, pinned so the two writers cannot drift
  // apart again: a seed and a distance built from the same drag spell the same.
  it('matches the sketch seed spelling', () => {
    const doc: PartDoc = {
      features: [{ id: 'sk', kind: 'sketch', entities: [{ id: 'c1', kind: 'circle' }], initial: {}, constraints: [] }],
    }
    const sketch = featureAt(doc, 0, 'sketch')
    const seed = [0, 0, MESSY].map(v => Math.round(v * 1e6) / 1e6)
    sketch.initial!['c1'] = seed
    applyAddExtrude(doc, 'ex1', undefined, '@sk/area1', MESSY)
    expect(seed[2]).toBe(featureById(doc, 'ex1', 'extrude').extrude.distance)
  })
})
