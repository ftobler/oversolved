// The wrap editor is a schema row (no editor component of its own): two picks
// and a number, the datum read off the target, so there is no origin, direction
// or seed field to offer. These pin the rows, the face-only target rule and the
// height's positive rule.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { WRAP_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { NumberFieldDef, PickFieldDef } from '@/components/editors/widgets/fieldTypes'
import type { WrapFeature, WrapFeatureDef } from '@/types/cad'

function makeFeature(overrides: Partial<WrapFeatureDef> = {}): WrapFeature {
  return { id: 'wr1', kind: 'wrap', wrap: { sketch: '', height: 1, ...overrides } }
}

const field = (key: string) => WRAP_SCHEMA.fields.find((f) => 'key' in f && f.key === key)

describe('WrapEditor (via FeatureEditor)', () => {
  it('is the schema the editor dispatches a wrap to', () => {
    expect(EDITOR_SCHEMAS.wrap).toBe(WRAP_SCHEMA)
  })

  it('offers the profile, target, height and operation, and no datum fields', () => {
    const keys = WRAP_SCHEMA.fields.map((f) => ('key' in f ? f.key : ''))
    expect(keys).toEqual(['sketch', 'target', 'height', 'operation', 'merge_target'])
  })

  it('renders both picks empty on a new wrap', () => {
    render(<FeatureEditor feature={makeFeature()} onMutation={vi.fn()} schema={WRAP_SCHEMA} />)
    expect(screen.getByText('Profile')).toBeTruthy()
    expect(screen.getByText('Target face')).toBeTruthy()
    expect(document.querySelectorAll('.feature-pick-chip.empty').length).toBeGreaterThanOrEqual(2)
  })

  it('takes only a named face as the target', () => {
    const target = field('target') as PickFieldDef
    expect(target.validatePick!('?15,4,9,7;@u|u_1@ex1@body_ex1@skc/c1:cylinderface')).toBeNull()
    expect(target.validatePick!('@body_ex1/face/2')).toBe('this face has no named query')
    expect(target.validatePick!('?1;@u|e_1@ex1@body_ex1:straightedge')).toBe('pick a face, not an edge or vertex')
    expect(target.validatePick!('@sk1')).toBe('pick a face')
  })

  it('refuses a height that is not positive', () => {
    const height = field('height') as NumberFieldDef
    expect(height.validate!(0)).not.toBeNull()
    expect(height.validate!(-1)).not.toBeNull()
    expect(height.validate!(0.5)).toBeNull()
  })
})
