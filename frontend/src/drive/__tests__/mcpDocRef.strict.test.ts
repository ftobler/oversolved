// @vitest-environment node
//
// The drive path refuses a document that breaks the served schema, by field
// path, while the browser loader keeps tolerating the same unknown key.
import { describe, it, expect } from 'vitest'
import { DocHandleStore } from '../docHandleStore'
import { resolveDoc } from '../mcpDocRef'
import { loadPartDoc } from '@/persistence/docSchema'

function part(feature: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { version: 4, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }, feature], ...extra }
}

const extrude = (params: Record<string, unknown>) => ({ id: 'e1', kind: 'extrude', extrude: params })

function problem(doc: unknown): string {
  const resolved = resolveDoc({ doc }, new DocHandleStore())
  if (resolved.ok) throw new Error('expected a refusal')
  return resolved.error
}

describe('strict document resolution on the drive path', () => {
  it('refuses a misspelled param inside a feature container', () => {
    expect(problem(part(extrude({ sketch: 'sk1', distance: 10, distanse: 4 })))).toContain('distanse')
  })

  it('refuses a param left flat beside its container', () => {
    expect(problem(part({ id: 'e1', kind: 'extrude', distance: 10, extrude: { sketch: 'sk1', distance: 10 } })))
      .toContain('distance')
  })

  it('accepts the sigil refs the drive mutations themselves store', () => {
    expect(resolveDoc({ doc: part(extrude({ sketch: ['$sk1'], distance: 10 })) }, new DocHandleStore()).ok).toBe(true)
  })

  it('refuses a misspelled top-level key', () => {
    expect(problem(part(extrude({ sketch: 'sk1', distance: 10 }), { featurs: [] }))).toContain('featurs')
  })

  it('refuses an unknown feature kind by path', () => {
    expect(problem(part({ id: 'x', kind: 'extrdue' }))).toContain('features[1].kind')
  })

  it('refuses an assembly part_instance without its instance', () => {
    const doc = { version: 4, kind: 'assembly', features: [{ id: 'i1', kind: 'part_instance' }] }
    const resolved = resolveDoc({ doc, kind: 'assembly' }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
  })

  it('accepts a valid document, including a builtin plane without a definition', () => {
    const doc = part(extrude({ sketch: 'sk1', distance: 10 }))
    ;(doc as { features: unknown[] }).features.unshift({ id: 'builtin_plane_top', kind: 'plane' })
    expect(resolveDoc({ doc }, new DocHandleStore()).ok).toBe(true)
  })

  it('leaves the browser loader tolerant of the same unknown key', () => {
    const loaded = loadPartDoc(part(extrude({ sketch: 'sk1', distance: 10, distanse: 4 })))
    expect(loaded.ok).toBe(true)
  })
})
