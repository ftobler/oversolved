// The shell editor schema's face pick must accept a face query and refuse an
// edge query, so a stray edge click cannot be persisted as a removed face (the
// kernel's face resolver would then strike it through as unresolved). The
// refusal carries the reason the user is shown.
import { describe, it, expect } from 'vitest'
import { SHELL_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'

const facesField = (): PickFieldDef => {
  const field = SHELL_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === 'faces')
  if (!field || field.type !== 'pick') throw new Error('no faces pick field')
  return field
}

describe('SHELL_SCHEMA', () => {
  it('is registered and defaults to an inward 1mm shell', () => {
    expect(EDITOR_SCHEMAS.shell).toBe(SHELL_SCHEMA)
    expect(SHELL_SCHEMA.subKey).toBe('shell')
    expect(SHELL_SCHEMA.mutationPrefix).toBe('set_shell')
    expect(SHELL_SCHEMA.defaults).toEqual({ faces: [], thickness: 1, direction: 'inward' })
  })

  it('accepts a face query', () => {
    const validate = facesField().validatePick
    expect(validate).toBeTypeOf('function')
    expect(validate!('?4;@ex1:flatface')).toBeNull()
    expect(validate!('?4;@ex1:cylinderface')).toBeNull()
  })

  it('refuses an edge query and a non-query, each with its reason', () => {
    const validate = facesField().validatePick!
    expect(validate('?4;@ex1:straightedge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:edge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:vertex')).toBe('pick a face, not an edge or vertex')
    expect(validate('@body_ex1/face/0')).toBe('this face has no named query')
    expect(validate('@builtin_plane_top')).toBe('pick a face')
  })

  it('shows the source_body pick only when no faces are open', () => {
    const body = SHELL_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === 'source_body')
    expect(body).toBeDefined()
    expect(body!.showWhen!({ faces: [] })).toBe(true)
    expect(body!.showWhen!({ faces: ['?f1'] })).toBe(false)
  })
})
