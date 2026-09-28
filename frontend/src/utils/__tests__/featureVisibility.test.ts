import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { visibleFeatureIds } from '@/utils/featureVisibility'

// The query a click on a sketch region commits (topologyDecorate's surface
// query), so the rule is exercised on the shape real picks store.
const area = (sk: string) => makeAncestryQuery([`@${sk}/c1`, 'surface:0', `@${sk}`], 'flatface')

const sketch = (id: string, extra: Partial<PartFeature> = {}): PartFeature => ({ id, kind: 'sketch', ...extra })
const extrude = (id: string, profiles: string[]): PartFeature =>
  ({ id, kind: 'extrude', extrude: { sketch: profiles, distance: 10 } })

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
})
