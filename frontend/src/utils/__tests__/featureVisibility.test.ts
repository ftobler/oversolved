import { describe, it, expect } from 'vitest'
import type { HelixFeature, SketchFeature, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { visibleFeatureIds } from '@/utils/featureVisibility'

// The query a click on a sketch region commits (topologyDecorate's surface
// query), so the rule is exercised on the shape real picks store.
const area = (sk: string) => makeAncestryQuery([`@${sk}/c1`, 'surface:0', `@${sk}`], 'flatface')

const sketch = (id: string, extra: Partial<SketchFeature> = {}): SketchFeature => ({ id, kind: 'sketch', ...extra })
const helix = (id: string, extra: Partial<HelixFeature> = {}): HelixFeature => ({ id, kind: 'helix', helix: {}, ...extra })
const extrude = (id: string, profiles: string[]): PartFeature =>
  ({ id, kind: 'extrude', extrude: { sketch: profiles, distance: 10 } })
const sweep = (id: string, path: string): PartFeature =>
  ({ id, kind: 'sweep', sweep: { sketch: '', path } })

// The mutation-driven side of the same rule (picks, un-picks, the eye icon and
// the bulk toggle) lives in yamlMutations.autoHide.test.ts.
describe('visibleFeatureIds', () => {
  it('hides a sketch an extrude consumes, with no flag in the document', () => {
    // Exactly what a document saved while auto-hide was off (2026-06-13 to
    // 2026-08-29) looks like on load. It used to stay drawn.
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features).has('sk1')).toBe(false)
  })

  it('shows a sketch nothing consumes', () => {
    const features = [sketch('sk1'), sketch('sk2'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features).has('sk2')).toBe(true)
  })

  it('hides every sketch a multi-profile extrude consumes', () => {
    const features = [sketch('sk1'), sketch('sk2'), extrude('ex1', [area('sk1'), `entity:sk2:line1`])]
    const shown = visibleFeatureIds(features)
    expect(shown.has('sk1')).toBe(false)
    expect(shown.has('sk2')).toBe(false)
  })

  it('does not draw the sketch behind a body face the open extrude profiles from', () => {
    // A real body face names its sketch's edges in the ancestry; the editor of
    // an extrude off that face must not count the sketch as its own profile.
    const face = makeAncestryQuery(['@u|u_0a3cb58fde38f980', '@ex1', '@body_ex1', '@sk1/left', '@cls_xn'], 'flatface')
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')]), extrude('ex2', [face])]
    expect(visibleFeatureIds(features, { editingFeatureId: 'ex2' }).has('sk1')).toBe(false)
  })

  it('honours a consumed sketch the user showed again (stamp spent, flag cleared)', () => {
    const features = [sketch('sk1', { auto_hidden: true }), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features).has('sk1')).toBe(true)
  })

  it('keeps a hidden, unconsumed sketch hidden', () => {
    expect(visibleFeatureIds([sketch('sk1', { visible: false })]).has('sk1')).toBe(false)
  })

  it('draws the open consumer its own profile sketch, and hides it once the editor closes', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features, { editingFeatureId: 'ex1' }).has('sk1')).toBe(true)
    expect(visibleFeatureIds(features, { editingFeatureId: null }).has('sk1')).toBe(false)
  })

  it('does not draw a sketch some OTHER consumer owns while an unrelated editor is open', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')]), sketch('sk2'), extrude('ex2', [area('sk2')])]
    const shown = visibleFeatureIds(features, { editingFeatureId: 'ex2' })
    expect(shown.has('sk1')).toBe(false)
    expect(shown.has('sk2')).toBe(true)
  })

  it('draws the sketch being edited even though a feature consumes it', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features, { editingFeatureId: 'sk1', forcedVisible: ['sk1'] }).has('sk1')).toBe(true)
  })

  // The first sketch hides the planes by a document write, but picking a plane
  // for a later sketch still needs them on screen: a hidden plane is not drawn,
  // so there is nothing to click. The armed pick field shows them by derivation,
  // the same way an open consumer shows its own profile sketch.
  it('draws the hidden planes while a plane pick field is armed', () => {
    const features: PartFeature[] = [
      { id: 'Origin', kind: 'origin', visible: false },
      { id: 'Top', kind: 'plane', visible: false },
      { id: 'Front', kind: 'plane', visible: false },
      { id: 'p1', kind: 'plane', visible: false },
    ]

    expect(visibleFeatureIds(features).has('Front')).toBe(false)

    const picking = visibleFeatureIds(features, { planePickArmed: true })
    expect(picking.has('Top')).toBe(true)
    expect(picking.has('Front')).toBe(true)
    expect(picking.has('p1')).toBe(true)
    // The origin is not a plane target, so arming the field does not turn it on.
    expect(picking.has('Origin')).toBe(false)
  })

  it('does not need the plane pick flag to draw planes that are already shown', () => {
    const features: PartFeature[] = [{ id: 'Front', kind: 'plane' }]
    expect(visibleFeatureIds(features, { planePickArmed: false }).has('Front')).toBe(true)
  })
})

describe('visibleFeatureIds treats a helix as sketch-class', () => {
  it('hides a helix a sweep uses as its path, with no flag in the document', () => {
    const features = [helix('hx1'), sweep('sw1', '@hx1')]
    expect(visibleFeatureIds(features).has('hx1')).toBe(false)
  })

  it('keeps a consumed helix shown once the user spent the one-shot hide', () => {
    const features = [helix('hx1', { auto_hidden: true }), sweep('sw1', '@hx1')]
    expect(visibleFeatureIds(features).has('hx1')).toBe(true)
  })

  it('shows the helix again when the sweep no longer uses it as a path', () => {
    const features = [helix('hx1'), sweep('sw1', '')]
    expect(visibleFeatureIds(features).has('hx1')).toBe(true)
  })

  it('keeps the consumed helix drawn while the sweep editor is open, so the path stays pickable', () => {
    const features = [helix('hx1'), sweep('sw1', '@hx1')]
    expect(visibleFeatureIds(features, { editingFeatureId: 'sw1' }).has('hx1')).toBe(true)
    expect(visibleFeatureIds(features, { editingFeatureId: null }).has('hx1')).toBe(false)
  })
})
