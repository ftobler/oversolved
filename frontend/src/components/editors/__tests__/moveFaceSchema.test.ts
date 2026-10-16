// The move-face editor schema: the face pick accepts only a planar (`flatface`)
// face query -- planarity is a kernel classification, so a cylinder/cone face
// must be refused at the chip, never sampled from triangles -- and the distance
// field is signed (no `> 0` validator).
import { describe, it, expect } from 'vitest'
import { MOVE_FACE_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef, NumberFieldDef } from '@/components/editors/widgets/fieldTypes'

const facesField = (): PickFieldDef => {
  const field = MOVE_FACE_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === 'faces')
  if (!field || field.type !== 'pick') throw new Error('no faces pick field')
  return field
}

describe('MOVE_FACE_SCHEMA', () => {
  it('is registered and defaults to a signed distance of 5', () => {
    expect(EDITOR_SCHEMAS.move_face).toBe(MOVE_FACE_SCHEMA)
    expect(MOVE_FACE_SCHEMA.subKey).toBe('move_face')
    expect(MOVE_FACE_SCHEMA.mutationPrefix).toBe('set_move_face')
    expect(MOVE_FACE_SCHEMA.defaults).toEqual({ faces: [], distance: 5 })
  })

  it('accepts a flat face query and refuses a curved or non-face one', () => {
    const validate = facesField().validatePick!
    expect(validate('?4;@ex1:flatface')).toBe(true)
    expect(validate('?4;@ex1:cylinderface')).toBe(false)
    expect(validate('?4;@ex1:coneface')).toBe(false)
    expect(validate('?4;@ex1:sphereface')).toBe(false)
    expect(validate('?4;@ex1:straightedge')).toBe(false)
    expect(validate('?4;@ex1:edge')).toBe(false)
    expect(validate('@body_ex1/face/0')).toBe(false)
  })

  it('accepts a negative distance (no positivity validator)', () => {
    const field = MOVE_FACE_SCHEMA.fields.find((f) => f.type === 'number' && f.key === 'distance')
    expect(field).toBeDefined()
    const number = field as NumberFieldDef
    expect(number.validate).toBeUndefined()
  })
})
