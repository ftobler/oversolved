import { describe, it, expect } from 'vitest'
import {
  applyToggleSketchPlaneVisibility,
  applyTogglePlaneVisibility,
  applyRenameFeature,
} from '@/utils/yamlMutations'
import type { PartDoc, PartFeature } from '@/types/cad'

// Bulk visibility toggles drive the `y` keyboard command and the plane-only
// toggle. Both are "hide everything if anything is showing, otherwise show
// everything" over a filtered target set. The tests pin the target set (which
// kinds participate) and the show/hide direction.

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      { id: 'Front', kind: 'plane' },
      { id: 'Right', kind: 'plane' },
      { id: 'p1', kind: 'plane' },
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ],
  } as PartDoc
}

function byId(doc: PartDoc, id: string): PartFeature {
  return doc.features!.find(f => f.id === id)!
}

describe('applyToggleSketchPlaneVisibility', () => {
  it('hides all sketches and planes when any is visible', () => {
    const doc = makeDoc()
    applyToggleSketchPlaneVisibility(doc)
    expect(byId(doc, 'Top').visible).toBe(false)
    expect(byId(doc, 'p1').visible).toBe(false)
    expect(byId(doc, 'sk1').visible).toBe(false)
  })

  it('does not touch the origin or solid features', () => {
    const doc = makeDoc()
    applyToggleSketchPlaneVisibility(doc)
    expect('visible' in byId(doc, 'Origin')).toBe(false)
    expect('visible' in byId(doc, 'ex1')).toBe(false)
  })

  it('shows all (deletes the visible key) when everything is already hidden', () => {
    const doc = makeDoc()
    for (const f of doc.features!) {
      if (f.kind === 'sketch' || f.kind === 'plane') f.visible = false
    }
    applyToggleSketchPlaneVisibility(doc)
    expect('visible' in byId(doc, 'Top')).toBe(false)
    expect('visible' in byId(doc, 'sk1')).toBe(false)
  })

  it('treats a partially-hidden set as "any visible" and hides the rest', () => {
    const doc = makeDoc()
    byId(doc, 'sk1').visible = false  // one already hidden, others still visible
    applyToggleSketchPlaneVisibility(doc)
    expect(byId(doc, 'Top').visible).toBe(false)
    expect(byId(doc, 'sk1').visible).toBe(false)
  })
})

describe('applyTogglePlaneVisibility', () => {
  it('hides every plane (builtin and user) but never the origin', () => {
    const doc = makeDoc()
    applyTogglePlaneVisibility(doc)
    expect(byId(doc, 'Top').visible).toBe(false)
    expect(byId(doc, 'Front').visible).toBe(false)
    expect(byId(doc, 'Right').visible).toBe(false)
    expect(byId(doc, 'p1').visible).toBe(false)
    expect('visible' in byId(doc, 'Origin')).toBe(false)
  })

  it('leaves sketches and solid features untouched', () => {
    const doc = makeDoc()
    applyTogglePlaneVisibility(doc)
    expect('visible' in byId(doc, 'sk1')).toBe(false)
    expect('visible' in byId(doc, 'ex1')).toBe(false)
  })

  it('shows all planes when every plane is hidden', () => {
    const doc = makeDoc()
    for (const id of ['Top', 'Front', 'Right', 'p1']) byId(doc, id).visible = false
    applyTogglePlaneVisibility(doc)
    expect('visible' in byId(doc, 'Top')).toBe(false)
    expect('visible' in byId(doc, 'p1')).toBe(false)
  })

  it('includes a builtin plane that lost its plane kind via the id fallback', () => {
    const doc = makeDoc()
    // A builtin renamed/retyped still counts as a plane target by id.
    byId(doc, 'Front').kind = 'sketch'
    applyTogglePlaneVisibility(doc)
    expect(byId(doc, 'Front').visible).toBe(false)
  })

  it('is a no-op on a doc with no features', () => {
    const doc = { version: 1, kind: 'part' } as PartDoc
    expect(() => applyTogglePlaneVisibility(doc)).not.toThrow()
  })
})

describe('applyRenameFeature empty label', () => {
  it('deletes the label when a non-variable feature is renamed to blank', () => {
    const doc = makeDoc()
    byId(doc, 'ex1').label = 'My Extrude'
    applyRenameFeature(doc, 'ex1', '   ')
    expect('label' in byId(doc, 'ex1')).toBe(false)
  })
})
