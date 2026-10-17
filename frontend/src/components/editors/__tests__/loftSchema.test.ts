// The loft editor schema's profile pick: the chip accepts every form the
// kernel's collector can resolve (a picked sketch area `?`, an absolute ref
// `@`, a sketch entity `entity:`, a local `$`) and refuses the rest with the
// reason the user is shown.
import { describe, it, expect } from 'vitest'
import { LOFT_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'

const profilesField = (): PickFieldDef => {
  const field = LOFT_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === 'profiles')
  if (!field || field.type !== 'pick') throw new Error('no profiles pick field')
  return field
}

describe('LOFT_SCHEMA', () => {
  it('is registered as a profile-list feature', () => {
    expect(EDITOR_SCHEMAS.loft).toBe(LOFT_SCHEMA)
    expect(LOFT_SCHEMA.subKey).toBe('loft')
    expect(LOFT_SCHEMA.mutationPrefix).toBe('set_loft')
    expect(profilesField().multi).toBe(true)
    expect(profilesField().addMutationType).toBe('add_loft_profile')
    expect(profilesField().removeMutationType).toBe('remove_loft_profile')
  })

  it('accepts a sketch area, an absolute ref, a sketch entity and a local', () => {
    const validate = profilesField().validatePick!
    expect(validate('?9;@body_ex1:flatface')).toBeNull()
    expect(validate('@sk1')).toBeNull()
    expect(validate('entity:sk1:c1')).toBeNull()
    expect(validate('$sk1')).toBeNull()
  })

  it('refuses a sketch vertex or a constraint with the reason', () => {
    const validate = profilesField().validatePick!
    const refusal = 'pick a sketch area, sketch element or face'
    expect(validate('vertex:sk1:l1:start')).toBe(refusal)
    expect(validate('constraint:sk1:c1')).toBe(refusal)
  })
})
