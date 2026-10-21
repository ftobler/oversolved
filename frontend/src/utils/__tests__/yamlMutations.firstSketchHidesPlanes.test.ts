// Rule: the moment the FIRST sketch in a document gets its plane, the
// reference planes are hidden. They are needed until that pick lands (a hidden
// plane is not drawn, so it cannot be picked) and are clutter afterwards. The
// hide is written by the same Mutation as the bind, so undoing the bind brings
// the planes back with it. A second sketch never re-hides them: after the user
// shows the planes again, a later bind leaves them shown.

import { describe, it, expect } from 'vitest'
import {
  applyAddSketch,
  applySetFeaturePlane,
  applyTogglePlaneVisibility,
  hidePlanes,
} from '@/utils/yamlMutations'
import { isPlaneVisibilityTarget } from '@/utils/featureVisibility'
import type { PartDoc, PartFeature, SketchFeature } from '@/types/cad'

const PLANE_IDS = ['Top', 'Front', 'Right', 'p1']

/** Built-ins plus a user plane, so every target class is present. */
function makeDoc(extra: PartFeature[], hidden: string[] = []): PartDoc {
  const hide = new Set(hidden)
  const planes: PartFeature[] = PLANE_IDS.map(id => {
    const feature: PartFeature = { id, kind: 'plane' }
    if (hide.has(id)) feature.visible = false
    return feature
  })
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'Origin', kind: 'origin' }, ...planes, ...extra],
  }
}

function byId(doc: PartDoc, id: string): PartFeature {
  return doc.features!.find(f => f.id === id)!
}

function sketchById(doc: PartDoc, id: string): SketchFeature {
  const feature = byId(doc, id)
  if (feature.kind !== 'sketch') throw new Error(`${id} is not a sketch`)
  return feature
}

/** Only the visibility state, keyed by id, so a bind can be compared without its own property change. */
function visibleFlags(doc: PartDoc): Record<string, boolean | undefined> {
  return Object.fromEntries((doc.features ?? []).map(f => [f.id, f.visible]))
}

describe('the first sketch hides the planes', () => {
  it('set_feature_plane on the only sketch hides Top/Front/Right and every user plane, not Origin', () => {
    const doc = makeDoc([{ id: 'sk1', kind: 'sketch' }])

    applySetFeaturePlane(doc, 'sk1', '@builtin_plane_front')

    expect(sketchById(doc, 'sk1').plane).toBe('@builtin_plane_front')
    for (const id of PLANE_IDS) expect(byId(doc, id).visible).toBe(false)
    expect('visible' in byId(doc, 'Origin')).toBe(false)
  })

  it('binding a second sketch changes no visibility, including after the planes were shown again', () => {
    // The user's `p` after the first bind dropped the flags again: the planes
    // are shown, and a second sketch must leave them that way.
    const doc = makeDoc([
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' },
      { id: 'sk2', kind: 'sketch' },
    ])
    const before = visibleFlags(doc)

    applySetFeaturePlane(doc, 'sk2', '@builtin_plane_top')

    expect(sketchById(doc, 'sk2').plane).toBe('@builtin_plane_top')
    expect(visibleFlags(doc)).toEqual(before)
  })

  it('binding a second sketch leaves already-hidden planes hidden', () => {
    const doc = makeDoc([
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' },
      { id: 'sk2', kind: 'sketch' },
    ], PLANE_IDS)

    applySetFeaturePlane(doc, 'sk2', '@builtin_plane_top')

    for (const id of PLANE_IDS) expect(byId(doc, id).visible).toBe(false)
  })

  it('add_sketch with a pre-bound plane as the first sketch hides the planes', () => {
    const doc = makeDoc([])

    applyAddSketch(doc, 'sk1', 'sketch 1', '@builtin_plane_front')

    expect(sketchById(doc, 'sk1').plane).toBe('@builtin_plane_front')
    for (const id of PLANE_IDS) expect(byId(doc, id).visible).toBe(false)
    expect('visible' in byId(doc, 'Origin')).toBe(false)
  })

  it('add_sketch without a plane changes no visibility', () => {
    const doc = makeDoc([])
    const before = visibleFlags(doc)

    applyAddSketch(doc, 'sk1', 'sketch 1')

    expect(sketchById(doc, 'sk1').plane).toBeUndefined()
    expect(visibleFlags(doc)).toEqual(before)
  })

  it('add_sketch with a pre-bound plane as a second sketch leaves visibility alone', () => {
    const doc = makeDoc([
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' },
    ])
    const before = visibleFlags(doc)

    applyAddSketch(doc, 'sk2', 'sketch 2', '@builtin_plane_top')

    expect(visibleFlags(doc)).toEqual(before)
  })

  it('rebinding the only sketch that already had a plane does not hide anything', () => {
    const doc = makeDoc([{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' }])
    const before = visibleFlags(doc)

    applySetFeaturePlane(doc, 'sk1', '@builtin_plane_top')

    expect(sketchById(doc, 'sk1').plane).toBe('@builtin_plane_top')
    expect(visibleFlags(doc)).toEqual(before)
  })

  it('already-hidden planes stay hidden and keep their explicit flag', () => {
    const doc = makeDoc([{ id: 'sk1', kind: 'sketch' }], ['Top', 'p1'])
    const top = byId(doc, 'Top')

    applySetFeaturePlane(doc, 'sk1', '@builtin_plane_front')

    expect(top.visible).toBe(false)
    expect('visible' in top).toBe(true)
    expect(byId(doc, 'p1').visible).toBe(false)
    expect(byId(doc, 'Front').visible).toBe(false)
  })
})

describe('isPlaneVisibilityTarget', () => {
  it('is the one target set the bulk toggle and the first-sketch hide share', () => {
    const doc = makeDoc([
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    ], ['Top'])
    const toggled = structuredClone(doc)
    applyTogglePlaneVisibility(toggled)
    const hidden = structuredClone(doc)

    hidePlanes(hidden)

    expect(hidden).toEqual(toggled)
  })

  it('counts user planes and the builtin id fallback, never the origin or a sketch', () => {
    expect(isPlaneVisibilityTarget({ id: 'p1', kind: 'plane' })).toBe(true)
    expect(isPlaneVisibilityTarget({ id: 'Front', kind: 'sketch' })).toBe(true)
    expect(isPlaneVisibilityTarget({ id: 'Origin', kind: 'origin' })).toBe(false)
    expect(isPlaneVisibilityTarget({ id: 'sk1', kind: 'sketch' })).toBe(false)
  })
})
