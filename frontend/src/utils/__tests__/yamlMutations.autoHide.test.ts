import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import {
  applyAddExtrudeProfile,
  applyAddRevolveProfile,
  applyAddSweepProfile,
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

// Consuming a sketch as a feature profile must never hide the sketch.
// Visibility is controlled by the user only.
describe('consuming a sketch does not auto-hide it', () => {
  it('extrude profile leaves the sketch visible', () => {
    const doc = makeDoc([sketchFeature('sk1'), extrudeFeature('ex1')])
    applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('revolve profile leaves the sketch visible', () => {
    const doc = makeDoc([sketchFeature('sk1'), revolveFeature('r1')])
    applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('sweep profile leaves the sketch visible', () => {
    const doc = makeDoc([sketchFeature('sk1'), sweepFeature('sw1')])
    applyAddSweepProfile(doc, 'sw1', 'entity:sk1:circle1')
    expect(doc.features![0].visible).toBeUndefined()
  })

  it('hole sketch leaves the sketch visible', () => {
    const doc = makeDoc([sketchFeature('sk1'), holeFeature('h1')])
    applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
    expect(doc.features![0].visible).toBeUndefined()
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
