import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import {
  applyAddExtrudeProfile,
  applyAddRevolveProfile,
  applySetHoleSketch,
  applyAddExtrude,
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

function holeFeature(id: string): PartFeature {
  return { id, kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind' as const, depth: 20 } }
}

describe('auto-hide consumed sketch (feature 223)', () => {
  describe('applyAddExtrudeProfile', () => {
    it('auto-hides sketch when entity: query references a sketch feature', () => {
      const doc = makeDoc([
        sketchFeature('sk1'),
        extrudeFeature('ex1'),
      ])
      applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('ex1')
    })

    it('does not re-hide sketch when auto_hidden_by is already set (user override)', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), auto_hidden_by: 'ex1' },
        extrudeFeature('ex2'),
      ])
      applyAddExtrudeProfile(doc, 'ex2', 'entity:sk1:circle1')
      // User previously overrode — should NOT be hidden by auto-hide
      expect(doc.features![0].visible).toBeUndefined()
      expect(doc.features![0].auto_hidden_by).toBe('ex1')  // unchanged
    })

    it('does not hide non-sketch feature references', () => {
      const doc = makeDoc([
        { id: 'sk1', kind: 'plane' },
        extrudeFeature('ex1'),
      ])
      applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
      // sk1 is a plane, not a sketch — should not be affected
      expect(doc.features![0].visible).toBeUndefined()
      expect(doc.features![0].auto_hidden_by).toBeUndefined()
    })

    it('only auto-hides on add (not on toggle/remove)', () => {
      const doc = makeDoc([
        sketchFeature('sk1'),
        extrudeFeature('ex1', ['entity:sk1:circle1']),
      ])
      // Toggle off — should NOT hide sketch
      applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
      expect(doc.features![0].visible).toBeUndefined()
      expect(doc.features![0].auto_hidden_by).toBeUndefined()
    })
  })

  describe('applyAddRevolveProfile', () => {
    it('auto-hides sketch consumed as revolve profile', () => {
      const doc = makeDoc([
        sketchFeature('sk1'),
        revolveFeature('r1'),
      ])
      applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('r1')
    })

    it('skips auto-hide when user override (auto_hidden_by set)', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), auto_hidden_by: 'old_ex1' },
        revolveFeature('r1'),
      ])
      applyAddRevolveProfile(doc, 'r1', 'entity:sk1:circle1')
      expect(doc.features![0].visible).toBeUndefined()
    })
  })

  describe('applySetHoleSketch', () => {
    it('auto-hides sketch consumed as hole profile', () => {
      const doc = makeDoc([
        sketchFeature('sk1'),
        holeFeature('h1'),
      ])
      applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('h1')
    })

    it('skips auto-hide when user override (auto_hidden_by set)', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), auto_hidden_by: 'old_ex1' },
        holeFeature('h1'),
      ])
      applySetHoleSketch(doc, 'h1', 'entity:sk1:point1')
      expect(doc.features![0].visible).toBeUndefined()
    })
  })

  describe('applySetFeatureVisibility', () => {
    it('keeps auto_hidden_by when user makes sketch visible (per-feature eye icon preserves override)', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), visible: false, auto_hidden_by: 'ex1' },
      ])
      applySetFeatureVisibility(doc, 'sk1', true)
      expect(doc.features![0].visible).toBeUndefined()
      expect(doc.features![0].auto_hidden_by).toBe('ex1')  // remains as override signal
    })

    it('does not clear auto_hidden_by when hiding', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), auto_hidden_by: 'ex1' },
      ])
      applySetFeatureVisibility(doc, 'sk1', false)
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('ex1')
    })
  })

  describe('applyToggleSketchPlaneVisibility', () => {
    it('clears auto_hidden_by when making sketches visible (bulk toggle)', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), visible: false, auto_hidden_by: 'ex1' },
        { ...sketchFeature('sk2'), visible: false, auto_hidden_by: 'ex2' },
      ])
      applyToggleSketchPlaneVisibility(doc)
      // All were hidden → now visible
      for (const f of doc.features!) {
        expect(f.visible).toBeUndefined()
        expect(f.auto_hidden_by).toBeUndefined()
      }
    })

    it('hides visible sketches without affecting auto_hidden_by', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), auto_hidden_by: 'ex1' },
      ])
      applyToggleSketchPlaneVisibility(doc)
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('ex1')
    })
  })

  describe('end-to-end: user override survives re-pick', () => {
    it('manual visibility toggle preserves override — prevents future auto-hide', () => {
      // Step 1: Add extrude that consumes sk1 → sk1 auto-hidden
      const doc = makeDoc([
        sketchFeature('sk1'),
        extrudeFeature('ex1'),
      ])
      applyAddExtrudeProfile(doc, 'ex1', 'entity:sk1:circle1')
      expect(doc.features![0].visible).toBe(false)
      expect(doc.features![0].auto_hidden_by).toBe('ex1')

      // Step 2: User manually shows sk1 via per-feature eye icon
      applySetFeatureVisibility(doc, 'sk1', true)
      expect(doc.features![0].visible).toBeUndefined()
      expect(doc.features![0].auto_hidden_by).toBe('ex1')  // override persists

      // Step 3: Add another extrude that also references sk1
      const doc2 = makeDoc([
        ...doc.features!,
        extrudeFeature('ex2'),
      ])
      applyAddExtrudeProfile(doc2, 'ex2', 'entity:sk1:circle1')
      // sk1 should NOT be auto-hidden again (auto_hidden_by flag signals override)
      expect(doc2.features![0].visible).toBeUndefined()
      expect(doc2.features![0].auto_hidden_by).toBe('ex1')
    })

    it('bulk toggle clears auto_hidden_by on all sketches', () => {
      const doc = makeDoc([
        { ...sketchFeature('sk1'), visible: false, auto_hidden_by: 'ex1' },
        { ...sketchFeature('sk2'), visible: false, auto_hidden_by: 'ex2' },
        { ...sketchFeature('sk3'), visible: false },
      ])
      applyToggleSketchPlaneVisibility(doc)
      // All were hidden → now visible, auto_hidden_by cleared
      for (const f of doc.features!) {
        expect(f.visible).toBeUndefined()
        expect(f.auto_hidden_by).toBeUndefined()
      }
    })
  })

  describe('applyAddExtrude with auto-activation (integration)', () => {
    it('auto-hide is not triggered during initial add_extrude (no profiles yet)', () => {
      const doc = makeDoc([
        sketchFeature('sk1'),
      ])
      applyAddExtrude(doc, 'ex1', 'My Extrude', 'entity:sk1:circle1', 10)
      // The sketch passed to add_extrude goes into the initial sketch array
      // Auto-hide happens only via applyAddExtrudeProfile, not applyAddExtrude
      expect(doc.features![0].visible).toBeUndefined()
    })
  })
})
