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

  it('accepts a flat face query', () => {
    expect(facesField().validatePick!('?4;@ex1:flatface')).toBeNull()
  })

  it('refuses a curved or unclassified face with the planarity reason', () => {
    // A pick can name a perfectly good named face query and still be refused
    // here, because move-face moves planar faces only. The reason must name that
    // rule, not claim the face has no query: the user picked a bore wall, which
    // the kernel named and the field refused for being curved.
    const validate = facesField().validatePick!
    for (const t of ['cylinderface', 'coneface', 'sphereface', 'torusface', 'face']) {
      expect(validate(`?4;@ex1:${t}`), t).toBe('move face only moves planar faces')
    }
  })

  it('refuses an edge, a vertex, a nameless face and a non-face by kind', () => {
    const validate = facesField().validatePick!
    expect(validate('?4;@ex1:straightedge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:edge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:vertex')).toBe('pick a face, not an edge or vertex')
    expect(validate('@body_ex1/face/0')).toBe('this face has no named query')
    expect(validate('@builtin_plane_top')).toBe('pick a face')
    expect(validate('@ex1')).toBe('pick a face')
  })

  it('accepts a negative distance (no positivity validator)', () => {
    const field = MOVE_FACE_SCHEMA.fields.find((f) => f.type === 'number' && f.key === 'distance')
    expect(field).toBeDefined()
    const number = field as NumberFieldDef
    expect(number.validate).toBeUndefined()
  })
})
