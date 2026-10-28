// The split editor schema: the pick list uses the plural body toggles with no
// `transform:` coercion, the plane pick accepts planes and flat faces only, and
// the keep select names the three sides.
import { describe, it, expect } from 'vitest'
import { SPLIT_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'

function pick(key: string): PickFieldDef {
  const field = SPLIT_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === key)
  if (!field || field.type !== 'pick') throw new Error(`no ${key} pick field`)
  return field
}

describe('SPLIT_SCHEMA', () => {
  it('is registered with its sub-key, defaults and field order', () => {
    expect(EDITOR_SCHEMAS.split).toBe(SPLIT_SCHEMA)
    expect(SPLIT_SCHEMA.subKey).toBe('split')
    expect(SPLIT_SCHEMA.defaults).toEqual({ bodies: [], plane: '', keep: 'above' })
    expect(SPLIT_SCHEMA.fields.map(f => f.key)).toEqual(['bodies', 'plane', 'keep'])
  })

  it('picks bodies through the plural toggles with no ref coercion', () => {
    const bodies = pick('bodies')
    expect(bodies.multi).toBe(true)
    expect(bodies.addMutationType).toBe('add_split_body')
    expect(bodies.addValueKey).toBe('bodyQuery')
    expect(bodies.removeMutationType).toBe('remove_split_body')
    expect(bodies.transform).toBeUndefined()
  })

  it('accepts a builtin plane, a datum plane and a flat face', () => {
    const validate = pick('plane').validatePick
    expect(validate).toBeTypeOf('function')
    expect(validate!('@builtin_plane_top')).toBeNull()
    expect(validate!('@pl1')).toBeNull()
    expect(validate!('?4;@ex1:flatface')).toBeNull()
  })

  it('refuses an edge, a body, a curved face and a sketch entity, each with a reason', () => {
    const validate = pick('plane').validatePick!
    expect(validate('?4;@ex1:straightedge')).toBe('pick a plane or a flat face, not an edge, vertex or curved face')
    expect(validate('?4;@ex1:vertex')).toBe('pick a plane or a flat face, not an edge, vertex or curved face')
    expect(validate('?4;@ex1:cylinderface')).toBe('pick a plane or a flat face, not an edge, vertex or curved face')
    expect(validate('@body_ex1')).toBe('pick a plane or a flat face, not a body')
    expect(validate('@sk1/l1')).toBe('pick a plane or a flat face, not a sketch entity')
  })

  it('names the three keep sides', () => {
    const keep = SPLIT_SCHEMA.fields.find(f => f.type === 'select' && f.key === 'keep')
    if (!keep || keep.type !== 'select') throw new Error('no keep select')
    expect(keep.options.map(o => o.value)).toEqual(['above', 'below', 'both'])
    expect(keep.default).toBe('above')
  })
})
