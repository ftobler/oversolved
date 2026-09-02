import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import {
  applyAddExtrude,
  applyAddExtrudeProfile,
  applyAddRevolveProfile,
  applyAddSweepProfile,
  applyAddSweepPath,
  applyRemoveExtrudeProfile,
  applySetHoleSketch,
} from '@/utils/yamlMutations/featureDefs'
import {
  applySetFeatureVisibility,
  applyToggleSketchPlaneVisibility,
} from '@/utils/yamlMutations/partStyle'

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

// A solid feature consumes the sketch it is built from: the profile wires are
// now inside a body, so the sketch hides itself and the viewport cleans up.
// The feature list stays linear -- "consumed" is a visibility flag, not a
// parent/child edge.
describe('consuming a sketch hides it', () => {
  it('extrude profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBe(false)
  })

  it('revolve profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), revolveFeature('r1')])
    applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBe(false)
  })

  it('sweep profile hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), sweepFeature('sw1')])
    applyAddSweepProfile(doc, 'sw1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBe(false)
  })

  it('sweep path hides the sketch it names', () => {
    // The spine is consumed exactly like the profile is.
    const doc = makeDoc([sketchFeature('sk1'), sweepFeature('sw1')])
    applyAddSweepPath(doc, 'sw1', 'entity:sk1:line1')
    expect(doc.features![0].visible).toBe(false)
  })

  it('hole sketch hides the sketch it names', () => {
    const doc = makeDoc([sketchFeature('sk1'), holeFeature('h1')])
    applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
    expect(doc.features![0].visible).toBe(false)
  })

  it('hides the sketch a feature is inserted with', () => {
    const doc = makeDoc([sketchFeature('sk1')])
    applyAddExtrude(doc, 'ex1', undefined, '@sk1/circle1', 10)
    expect(doc.features![0].visible).toBe(false)
  })

  it('hides only the sketch the query names', () => {
    const doc = makeDoc([sketchFeature('sk1'), sketchFeature('sk2'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk2:circle1')
    expect(doc.features![0].visible).toBeUndefined()
    expect(doc.features![1].visible).toBe(false)
  })

  it('leaves a body-face profile alone (no sketch consumed)', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex2', 'face:ex1:@ex1/face0')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('stamps auto_hidden on the sketch it hides', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(doc.features![0].auto_hidden).toBe(true)
  })

  it('un-picking a profile does not bring the sketch back', () => {
    // Once hidden, the flag is the user's own setting again: a remove that
    // silently re-showed the sketch would fight whoever turned it off.
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(doc.features![0].visible).toBe(false)
    expect(doc.features![1].extrude!.sketch).toEqual([])
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
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('stays out of the way for good, not just for the next consume', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), revolveFeature('r1'), holeFeature('h1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applySetFeatureVisibility(doc, 'sk1', true)
    applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
    applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('does not re-hide a sketch shown again by the bulk toggle', () => {
    // The sketch/plane toggle is the other user-driven way back on screen; the
    // stamp has to survive it too.
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyToggleSketchPlaneVisibility(doc)
    expect(doc.features![0].visible).toBeUndefined()
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('a second consume leaves a still-hidden sketch hidden', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1'), extrudeFeature('ex2')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle2')
    expect(doc.features![0].visible).toBe(false)
  })

  it('hides a sketch that was never consumed before, however it got its visibility', () => {
    // A sketch the user had hidden and shown again carries no stamp: the first
    // consume is still owed its one hide.
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applySetFeatureVisibility(doc, 'sk1', false)
    applySetFeatureVisibility(doc, 'sk1', true)
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBe(false)
  })
})
