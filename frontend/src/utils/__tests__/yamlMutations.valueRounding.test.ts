import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddExtrude,
  applyAddRevolve,
  applyAddFillet,
  applyAddChamfer,
  applyAddShell,
  applyAddArray,
  applyAddCircularArray,
  applyAddHole,
  applyAddPlane,
  applySetExtrudeField,
  applySetHelixField,
  applySetHoleField,
  applySetShellField,
  applySetTransformField,
  applySetArrayField,
  applySetPlaneDefinitionField,
} from '@/utils/yamlMutations'
import { round } from '@/utils/yamlMutations/helpers'
import { featureAt, featureById } from '@/testing/featureAccess'

// One stored precision for a feature number and a sketch seed. The sketch
// mutators already persisted their seeds through round (helpers.ts, 1e-6);
// feature writes stored the authored float verbatim, so one drag could spell
// 0.351324 in a profile and 0.351324026 in the feature built from it. The
// feature side now crosses the same boundary. (Constraint VALUES keep their own
// 1e-3 rule, and a mate's params are written outside yamlMutations.)
const MESSY = 0.351324026
const MESSY_ROUNDED = 0.351324

const extrude0 = (doc: PartDoc) => featureAt(doc, 0, 'extrude').extrude
const revolve0 = (doc: PartDoc) => featureAt(doc, 0, 'revolve').revolve
const fillet0 = (doc: PartDoc) => featureAt(doc, 0, 'fillet').fillet
const chamfer0 = (doc: PartDoc) => featureAt(doc, 0, 'chamfer').chamfer
const shell0 = (doc: PartDoc) => featureAt(doc, 0, 'shell').shell
const hole0 = (doc: PartDoc) => featureAt(doc, 0, 'hole').hole
const array0 = (doc: PartDoc) => featureAt(doc, 0, 'array').array
const helix0 = (doc: PartDoc) => featureAt(doc, 0, 'helix').helix
const plane0 = (doc: PartDoc) => featureAt(doc, 0, 'plane').definition!

describe('feature value rounding', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe('the boundary helper', () => {
    // A tiny negative reached the YAML as `-0`, the spelling this repo folds away
    // everywhere else (builderHash, the fuzz harness). A huge finite input
    // overflows `v * 1e6` to Infinity, so its vetted spelling is kept.
    it('folds -0 and never turns a finite input non-finite', () => {
      expect(Object.is(round(-3e-7), 0)).toBe(true)
      expect(JSON.stringify({ v: round(-3e-7) })).toBe('{"v":0}')
      expect(round(1e303)).toBe(1e303)
      expect(Number.isFinite(round(1e303))).toBe(true)
      expect(Number.isNaN(round(NaN))).toBe(true)  // the finiteness gates stay the gate
    })
  })

  describe('adds store the rounded spelling', () => {
    it('applyAddExtrude rounds its distance', () => {
      const doc: PartDoc = { features: [] }
      applyAddExtrude(doc, 'ex1', undefined, '$sk1', MESSY)
      expect(extrude0(doc).distance).toBe(MESSY_ROUNDED)
    })

    it('applyAddRevolve rounds its angle', () => {
      const doc: PartDoc = { features: [] }
      applyAddRevolve(doc, 'rv1', undefined, '$sk1', MESSY)
      expect(revolve0(doc).angle).toBe(MESSY_ROUNDED)
    })

    // These three take a NumberOrExpr straight into the def literal, so they are
    // the paths where a messy authored radius or thickness actually bypassed
    // setFeatureField.
    it('applyAddFillet rounds a messy radius', () => {
      const doc: PartDoc = { features: [] }
      applyAddFillet(doc, 'fl1', undefined, ['$e1'], MESSY)
      expect(fillet0(doc).radius).toBe(MESSY_ROUNDED)
    })

    it('applyAddChamfer rounds a messy distance', () => {
      const doc: PartDoc = { features: [] }
      applyAddChamfer(doc, 'ch1', undefined, ['$e1'], MESSY)
      expect(chamfer0(doc).distance).toBe(MESSY_ROUNDED)
    })

    it('applyAddShell rounds a messy thickness', () => {
      const doc: PartDoc = { features: [] }
      applyAddShell(doc, 'sh1', undefined, ['$f1'], MESSY)
      expect(shell0(doc).thickness).toBe(MESSY_ROUNDED)
    })

    it('a one-call hole add rounds its depth', () => {
      const doc: PartDoc = { features: [] }
      applyAddHole(doc, 'ho1', undefined, { depth: MESSY })
      expect(hole0(doc).depth).toBe(MESSY_ROUNDED)
    })

    it('a numeric tuple rounds per component and keeps its zero components', () => {
      const doc: PartDoc = { features: [{ id: 'tr1', kind: 'transform', transform: { bodies: [] } }] }
      applySetTransformField(doc, 'tr1', 'translation', [MESSY, 0, 10.0000004])
      expect(featureAt(doc, 0, 'transform').transform.translation).toEqual([MESSY_ROUNDED, 0, 10])
    })
  })

  describe('setters and inline adds spell the same value', () => {
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

    // A plane offset feeds the solver exactly like a feature distance, so it
    // carries the same precision.
    it('a plane definition rounds its offset', () => {
      const added: PartDoc = { features: [] }
      applyAddPlane(added, 'pl1', undefined, { mode: 'offset', plane: '@builtin_plane_front', offset: MESSY })
      expect(plane0(added).offset).toBe(MESSY_ROUNDED)
      const set: PartDoc = { features: [{ id: 'pl1', kind: 'plane', definition: { mode: 'offset', offset: 5 } }] }
      applySetPlaneDefinitionField(set, 'pl1', 'offset', MESSY)
      expect(plane0(set).offset).toBe(MESSY_ROUNDED)
    })

    // The add copies the definition it rounds: a journaled add_plane replays its
    // payload, and rounding it in place would rewrite the journal's record.
    it('an add rounds a copy, not the payload it was given', () => {
      const definition = { mode: 'offset', offset: MESSY }
      const doc: PartDoc = { features: [] }
      applyAddPlane(doc, 'pl1', undefined, definition)
      expect(definition.offset).toBe(MESSY)
      expect(plane0(doc).offset).toBe(MESSY_ROUNDED)
    })

    // A clean authored value must survive byte-identically: a re-spelled 25.7
    // would read as a change to every save-identity and checkpoint-hash guard.
    it('leaves a clean value byte-identical', () => {
      const doc: PartDoc = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } }] }
      applySetExtrudeField(doc, 'ex1', 'distance', 25.7)
      expect(extrude0(doc).distance).toBe(25.7)
      applySetExtrudeField(doc, 'ex1', 'distance', 0.1 + 0.2)
      expect(extrude0(doc).distance).toBe(0.3)  // the round also cleans f64 noise out of stored docs
    })

    // NumberOrExpr fields may hold a string expression; only a numeric write is a
    // number to round, and an expression must reach the evaluator untouched.
    it('leaves an expression string untouched', () => {
      const doc: PartDoc = { features: [{ id: 'hx1', kind: 'helix', helix: {} }] }
      applySetHelixField(doc, 'hx1', 'pitch', 'width * 0.351324026')
      expect(helix0(doc).pitch).toBe('width * 0.351324026')
    })

    it('matches the sketch seed spelling of the same authored value', () => {
      const doc: PartDoc = {
        features: [{ id: 'sk', kind: 'sketch', entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [0, 0, MESSY_ROUNDED] }, constraints: [] }],
      }
      applyAddExtrude(doc, 'ex1', undefined, '@sk/area1', MESSY)
      expect(featureAt(doc, 0, 'sketch').initial!.c1[2]).toBe(featureById(doc, 'ex1', 'extrude').extrude.distance)
    })
  })

  describe('the round must not author a document the loader refuses', () => {
    // A magnitude below half the stored precision would store as zero, and every
    // loader range rule rejects zero (a positive thickness or angle, a count >= 1).
    it('refuses a magnitude the round would collapse to zero', () => {
      const doc: PartDoc = {
        features: [
          { id: 'ho1', kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20 } },
          { id: 'sh1', kind: 'shell', shell: { faces: [], thickness: 1 } },
        ],
      }
      applySetHoleField(doc, 'ho1', 'depth', 3e-7)
      applySetShellField(doc, 'sh1', 'thickness', 3e-7)
      expect(featureById(doc, 'ho1', 'hole').hole.depth).toBe(20)
      expect(featureById(doc, 'sh1', 'shell').shell.thickness).toBe(1)
      expect(warnSpy).toHaveBeenCalled()
    })

    // 0 and 90 are the degenerate ends of the helix parametrisation the loader
    // holds a literal angle to; a write may not land on either.
    it('refuses a helix angle the round lands on a degenerate end', () => {
      const doc: PartDoc = { features: [{ id: 'hx1', kind: 'helix', helix: { helix_angle: 30 } }] }
      applySetHelixField(doc, 'hx1', 'helix_angle', 89.99999994)
      expect(helix0(doc).helix_angle).toBe(30)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('between 0 and 90'))
      applySetHelixField(doc, 'hx1', 'helix_angle', 45)
      expect(helix0(doc).helix_angle).toBe(45)
    })

    // A fractional count is a refusal, not a value to round into the legal
    // integer: the add and the setter must hand out one verdict for one input.
    it('refuses a fractional inline count the setter also refuses', () => {
      const added: PartDoc = { features: [] }
      applyAddArray(added, 'ar1', undefined, { count_x: 2.4 })
      expect(added.features).toHaveLength(0)
      applyAddCircularArray(added, 'ca1', undefined, { count: 3.5 })
      expect(added.features).toHaveLength(0)
      const set: PartDoc = { features: [{ id: 'ar2', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 5 } }] }
      applySetArrayField(set, 'ar2', 'count_x', 2.4)
      expect(array0(set).count_x).toBe(2)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('keeps refusing a non-finite value beside the round', () => {
      const doc: PartDoc = { features: [{ id: 'ho1', kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20 } }] }
      applySetHoleField(doc, 'ho1', 'depth', NaN)
      expect(hole0(doc).depth).toBe(20)
      expect(warnSpy).toHaveBeenCalled()
    })
  })
})
