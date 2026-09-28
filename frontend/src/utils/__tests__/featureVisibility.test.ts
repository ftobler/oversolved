import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { docVisibleFeatureIds, visibleFeatureIds } from '@/utils/featureVisibility'
import { applyAddExtrude, applyAddExtrudeProfile } from '@/utils/yamlMutations/featureDefs'
import {
  applyReorderFeatures,
  applySetFeatureVisibility,
  applyToggleSketchPlaneVisibility,
} from '@/utils/yamlMutations/partStyle'

// The query a click on a sketch region commits (topologyDecorate's surface
// query), so the rule is exercised on the shape real picks store.
const area = (sk: string) => makeAncestryQuery([`@${sk}/c1`, 'surface:0', `@${sk}`], 'flatface')

const sketch = (id: string, extra: Partial<PartFeature> = {}): PartFeature => ({ id, kind: 'sketch', ...extra })
const extrude = (id: string, profiles: string[]): PartFeature =>
  ({ id, kind: 'extrude', extrude: { sketch: profiles, distance: 10 } })

describe('visibleFeatureIds', () => {
  it('hides a sketch an extrude after it consumes', () => {
    // No visible flag and no stamp: the consumer reached the doc without the
    // pick-time hide, exactly what a document saved while auto-hide was off
    // (2026-06-13 to 2026-08-29) looks like on load. It used to stay drawn.
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features).has('sk1')).toBe(false)
  })

  it('shows a sketch nothing consumes', () => {
    const features = [sketch('sk1'), sketch('sk2'), extrude('ex1', [area('sk1')])]
    expect(visibleFeatureIds(features).has('sk2')).toBe(true)
  })

  it('hides the sketch of an extrude inserted before the end of the tree', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')]), sketch('sk2')]
    const shown = visibleFeatureIds(features)
    expect(shown.has('sk1')).toBe(false)
    expect(shown.has('sk2')).toBe(true)
  })

  it('hides every sketch a multi-profile extrude consumes', () => {
    const features = [sketch('sk1'), sketch('sk2'), extrude('ex1', [area('sk1'), `entity:sk2:line1`])]
    const shown = visibleFeatureIds(features)
    expect(shown.has('sk1')).toBe(false)
    expect(shown.has('sk2')).toBe(false)
  })

  it('leaves a sketch alone when the extrude profile is a body face', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')]), sketch('sk2'), extrude('ex2', ['face:ex1:@ex1/face0'])]
    expect(visibleFeatureIds(features).has('sk2')).toBe(true)
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
})

describe('consumed sketch visibility through the mutations', () => {
  const doc = (features: PartFeature[]): PartDoc => ({ features })

  it('an extrude appended then moved before the end still hides its sketch', () => {
    // Reorder clamps user features behind the built-ins, so they are present.
    const builtins: PartFeature[] = [...BUILTIN_FEATURE_IDS].map(id => ({ id, kind: 'plane' }))
    const d = doc([...builtins, sketch('sk1'), sketch('sk2')])
    applyAddExtrude(d, 'ex1', undefined, '', 10)
    applyReorderFeatures(d, 'ex1', builtins.length + 1)
    applyAddExtrudeProfile(d, 'ex1', area('sk1'))
    expect(d.features!.slice(builtins.length).map(f => f.id)).toEqual(['sk1', 'ex1', 'sk2'])
    const shown = docVisibleFeatureIds(d.features!)
    expect(shown.has('sk1')).toBe(false)
    expect(shown.has('sk2')).toBe(true)
  })

  it('the eye icon can show a consumed sketch no pick ever hid', () => {
    // Clearing the flag alone would change nothing on screen: the derived
    // rule would still hide it. The show spends the one-shot instead.
    const d = doc([sketch('sk1'), extrude('ex1', [area('sk1')])])
    applySetFeatureVisibility(d, 'sk1', true)
    expect(d.features![0].auto_hidden).toBe(true)
    expect(docVisibleFeatureIds(d.features!).has('sk1')).toBe(true)
  })

  it('showing an unconsumed sketch leaves its one-shot for the first consume', () => {
    const d = doc([sketch('sk1'), extrude('ex1', [])])
    applySetFeatureVisibility(d, 'sk1', true)
    expect(d.features![0].auto_hidden).toBeUndefined()
    applyAddExtrudeProfile(d, 'ex1', area('sk1'))
    expect(docVisibleFeatureIds(d.features!).has('sk1')).toBe(false)
  })

  it('the bulk toggle treats a derived-hidden sketch as hidden and can show it', () => {
    const d = doc([sketch('sk1'), extrude('ex1', [area('sk1')])])
    // Nothing is on screen, so the toggle's direction is "show".
    applyToggleSketchPlaneVisibility(d)
    expect(docVisibleFeatureIds(d.features!).has('sk1')).toBe(true)
    applyToggleSketchPlaneVisibility(d)
    expect(docVisibleFeatureIds(d.features!).has('sk1')).toBe(false)
  })
})
