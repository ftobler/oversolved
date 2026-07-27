// Every editor field that names a whole body writes a value straight into the
// document, so the transform on it decides what the kernel will later have to
// resolve. `merge_target` used to have its own transform that turned the `?`
// query of a body pick into `'@body_' + <everything before the first slash>` --
// `?4;@ex1:solid` became the literal body id `@body_4;@ex1:solid`, persisted,
// and unresolvable. This pins that the body-naming fields all use the one
// transform that leaves body-exact refs alone.
import { describe, it, expect } from 'vitest'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { FeatureEditorSchema } from '@/components/editors/FeatureEditor'

const BODY_FIELD_KEYS = new Set(['merge_target', 'source_body'])

function bodyFields(): { kind: string; key: string; transform?: (id: string) => string }[] {
  const out: { kind: string; key: string; transform?: (id: string) => string }[] = []
  for (const [kind, schema] of Object.entries(EDITOR_SCHEMAS as Record<string, FeatureEditorSchema>)) {
    for (const field of schema.fields) {
      if (field.type === 'pick' && BODY_FIELD_KEYS.has(field.key)) {
        out.push({ kind, key: field.key, transform: field.transform })
      }
    }
  }
  return out
}

describe('body-naming pick fields', () => {
  it('covers every schema that has one', () => {
    // extrude, revolve, sweep (merge_target) + array, circular_array (source_body)
    expect(bodyFields().map(f => `${f.kind}.${f.key}`).sort()).toEqual([
      'array.source_body',
      'circular_array.source_body',
      'extrude.merge_target',
      'revolve.merge_target',
      'sweep.merge_target',
    ])
  })

  it('persists a body-exact "?" pick verbatim, never a minted "@body_" id', () => {
    const picked = '?4;@body_ex1_1@ex1:face'
    for (const { kind, key, transform } of bodyFields()) {
      expect(transform, `${kind}.${key} has no transform`).toBeTypeOf('function')
      expect(transform!(picked), `${kind}.${key}`).toBe(picked)
    }
  })

  it('keeps a split sibling id whole', () => {
    for (const { kind, key, transform } of bodyFields()) {
      expect(transform!('@body_ex1_1/face/0'), `${kind}.${key}`).toBe('@body_ex1_1')
    }
  })
})
