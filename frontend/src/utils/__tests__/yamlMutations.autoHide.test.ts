import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { docVisibleFeatureIds } from '@/utils/featureVisibility'
import {
  applyAddExtrude,
  applyAddExtrudeProfile,
  applyAddRevolveProfile,
  applyAddSweepProfile,
  applyAddSweepPath,
  applyRemoveExtrudeProfile,
  applySetHoleSketch,
} from '@/utils/yamlMutations/featureDefs'
import { applyDeleteFeature } from '@/utils/yamlMutations'
import {
  applyReorderFeatures,
  applySetFeatureVisibility,
  applyToggleSketchPlaneVisibility,
} from '@/utils/yamlMutations/partStyle'

// The auto-hide is derived from what the document consumes (featureVisibility);
// these drive it through the real mutations and read what would be drawn.

function makeDoc(features: PartFeature[]): PartDoc {
  return { features }
}

function sketchFeature(id: string, visible?: boolean): PartFeature {
  return { id, kind: 'sketch', visible: visible === false ? false : undefined }
}

function extrudeFeature(id: string, sketch?: string[]): PartFeature {
  return { id, kind: 'extrude', extrude: { sketch: sketch ?? [], distance: 10 } }
}

function revolveFeature(id: string, sketch?: string[]): PartFeature {
  return { id, kind: 'revolve', revolve: { sketch: sketch ?? [], angle: 360 } }
}

function sweepFeature(id: string): PartFeature {
  return { id, kind: 'sweep', sweep: { sketch: [], path: '' } }
}

function holeFeature(id: string): PartFeature {
  return { id, kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind' as const, depth: 20 } }
}

const drawn = (doc: PartDoc, id: string) => docVisibleFeatureIds(doc.features ?? []).has(id)

// A solid feature consumes the sketch it is built from: the profile wires are
// now inside a body, so the sketch is not drawn. The feature list stays
// linear -- "consumed" is a visibility rule, not a parent/child edge.
describe('consuming a sketch hides it', () => {
  it('extrude profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('revolve profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), revolveFeature('r1')])
    applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('sweep profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), sweepFeature('sw1')])
    applyAddSweepProfile(doc, 'sw1', 'entity:sk1:circle1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('sweep path hides the sketch it names', () => {
    // The spine is consumed exactly like the profile is.
    const doc = makeDoc([sketchFeature('sk1'), sweepFeature('sw1')])
    applyAddSweepPath(doc, 'sw1', 'entity:sk1:line1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('hole sketch hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), holeFeature('h1')])
    applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('hides the sketch a feature is inserted with', () => {
    const doc = makeDoc([sketchFeature('sk1')])
    applyAddExtrude(doc, 'ex1', undefined, '@sk1/circle1', 10)
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('hides only the sketch the query names', () => {
    const doc = makeDoc([sketchFeature('sk1'), sketchFeature('sk2'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk2:circle1')
    expect(drawn(doc, 'sk1')).toBe(true)
    expect(drawn(doc, 'sk2')).toBe(false)
  })

  it('leaves the sketch behind a body-face profile alone', () => {
    // A shown sketch stays shown when a later extrude profiles off a face of the
    // body it built, although the face's ancestry names the sketch's edges.
    const face = makeAncestryQuery(['@ex1', '@body_ex1', '@sk1/left'], 'flatface')
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1', ['@sk1/c1']), extrudeFeature('ex2')])
    applySetFeatureVisibility(doc, 'sk1', true)
    applyAddExtrudeProfile(doc, 'ex2', face)
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('an extrude appended then moved before the end still hides its sketch', () => {
    // Reorder clamps user features behind the built-ins, so they are present.
    const builtins: PartFeature[] = [...BUILTIN_FEATURE_IDS].map(id => ({ id, kind: 'plane' }))
    const doc = makeDoc([...builtins, sketchFeature('sk1'), sketchFeature('sk2')])
    applyAddExtrude(doc, 'ex1', undefined, '', 10)
    applyReorderFeatures(doc, 'ex1', builtins.length + 1)
    applyAddExtrudeProfile(doc, 'ex1', '@sk1/c1')
    expect(doc.features!.slice(builtins.length).map(f => f.id)).toEqual(['sk1', 'ex1', 'sk2'])
    expect(drawn(doc, 'sk1')).toBe(false)
    expect(drawn(doc, 'sk2')).toBe(true)
  })
})

// Nothing consuming the sketch any more means nothing to hide it for.
describe('the auto-hide ends with the consumption', () => {
  it('un-picking the only profile brings the sketch back', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(doc.features![1].extrude!.sketch).toEqual([])
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('deleting the consumer brings the sketch back', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1', ['@sk1/c1'])])
    applyDeleteFeature(doc, 'ex1')
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('never lifts a hide the user set', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applySetFeatureVisibility(doc, 'sk1', false)
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(drawn(doc, 'sk1')).toBe(false)
  })
})

describe('manual visibility toggles', () => {
  it('applySetFeatureVisibility hides and shows a sketch', () => {
    const doc = makeDoc([sketchFeature('sk1')])
    applySetFeatureVisibility(doc, 'sk1', false)
    expect(doc.features![0].visible).toBe(false)
    applySetFeatureVisibility(doc, 'sk1', true)
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('applyToggleSketchPlaneVisibility shows all when any are hidden', () => {
    const doc = makeDoc([
      sketchFeature('sk1', false),
      sketchFeature('sk2', false),
    ])
    applyToggleSketchPlaneVisibility(doc)
    for (const f of doc.features!) {
      expect(f.visible).toBeUndefined()
    }
  })

  it('applyToggleSketchPlaneVisibility hides all when any are visible', () => {
    const doc = makeDoc([sketchFeature('sk1')])
    applyToggleSketchPlaneVisibility(doc)
    expect(doc.features![0].visible).toBe(false)
  })

  it('the bulk toggle reads an auto-hidden sketch as hidden, so its first press shows it', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1', ['@sk1/c1'])])
    applyToggleSketchPlaneVisibility(doc)
    expect(drawn(doc, 'sk1')).toBe(true)
    applyToggleSketchPlaneVisibility(doc)
    expect(drawn(doc, 'sk1')).toBe(false)
  })
})

// The auto-hide fires once per sketch and then gets out of the way: a sketch
// feeding several features must not be yanked off screen again every time a
// later feature picks from it, or it would overrule the user who turned it
// back on.
describe('the auto-hide is a one-shot', () => {
  it('does not re-hide a sketch the user showed again', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applySetFeatureVisibility(doc, 'sk1', true)
    expect(drawn(doc, 'sk1')).toBe(true)
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('stays out of the way for good, not just for the next consume', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), revolveFeature('r1'), holeFeature('h1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applySetFeatureVisibility(doc, 'sk1', true)
    applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
    applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('does not re-hide a sketch shown again by the bulk toggle', () => {
    // The sketch/plane toggle is the other user-driven way back on screen; the
    // stamp has to survive it too.
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyToggleSketchPlaneVisibility(doc)
    expect(drawn(doc, 'sk1')).toBe(true)
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(drawn(doc, 'sk1')).toBe(true)
  })

  it('a second consume leaves a still-hidden sketch hidden', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(drawn(doc, 'sk1')).toBe(false)
  })

  it('a show before any consume leaves the one-shot for the first consume', () => {
    // A sketch the user had hidden and shown again carries no stamp: the first
    // consume is still owed its one hide.
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applySetFeatureVisibility(doc, 'sk1', false)
    applySetFeatureVisibility(doc, 'sk1', true)
    expect(doc.features![0].auto_hidden).toBeUndefined()
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(drawn(doc, 'sk1')).toBe(false)
  })
})
