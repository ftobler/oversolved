// The delete-face editor schema's face pick must accept any face query (every
// surface type; the kernel refuses what it cannot heal) and refuse edges,
// vertices and bodies at the chip, so a stray edge click is never persisted as
// a face to delete. The refusal carries the reason the user is shown.
import { describe, it, expect } from 'vitest'
import { DELETE_FACE_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'

const facesField = (): PickFieldDef => {
  const field = DELETE_FACE_SCHEMA.fields.find((f) => f.type === 'pick' && f.key === 'faces')
  if (!field || field.type !== 'pick') throw new Error('no faces pick field')
  return field
}

describe('DELETE_FACE_SCHEMA', () => {
  it('is registered as a face-list feature with no scalar params', () => {
    expect(EDITOR_SCHEMAS.delete_face).toBe(DELETE_FACE_SCHEMA)
    expect(DELETE_FACE_SCHEMA.subKey).toBe('delete_face')
    expect(DELETE_FACE_SCHEMA.defaults).toEqual({ faces: [] })
    expect(facesField().multi).toBe(true)
    expect(facesField().addMutationType).toBe('add_delete_face_ref')
    expect(facesField().removeMutationType).toBe('remove_delete_face_ref')
  })

  it('accepts a face query of any surface type', () => {
    const validate = facesField().validatePick
    expect(validate).toBeTypeOf('function')
    for (const t of ['flatface', 'cylinderface', 'coneface', 'sphereface', 'torusface', 'face']) {
      expect(validate!(`?4;@ex1:${t}`), t).toBeNull()
    }
  })

  it('refuses an edge, a vertex and a non-query, each with its reason', () => {
    const validate = facesField().validatePick!
    expect(validate('?4;@ex1:straightedge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:edge')).toBe('pick a face, not an edge or vertex')
    expect(validate('?4;@ex1:vertex')).toBe('pick a face, not an edge or vertex')
    expect(validate('@body_ex1/face/0')).toBe('this face has no named query')
    expect(validate('@ex1')).toBe('pick a face')
  })
})
