// The move-face editor schema: the face pick accepts every analytic surface
// kind (`flatface` through `torusface`) -- the surface kind is a kernel
// classification, so a bare `:face` is refused at the chip, never sampled from
// triangles -- and the distance field is signed (no `> 0` validator).
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

  it('accepts every analytic face query', () => {
    const validate = facesField().validatePick!
    for (const t of ['flatface', 'cylinderface', 'coneface', 'sphereface', 'torusface']) {
      expect(validate(`?4;@ex1:${t}`), t).toBeNull()
    }
  })

  it('refuses an unclassified face with the analytic-kinds reason', () => {
    // A bare `:face` is a B-spline or an unknown surface: the kernel cannot
    // offset it, so the chip says which kinds move. The reason must name that
    // rule, not claim the face has no query.
    expect(facesField().validatePick!('?4;@ex1:face')).toBe(
      'move face only moves analytic faces (plane, cylinder, cone, sphere, torus)',
    )
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
