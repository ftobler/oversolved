// The catalog and schema notes the 2026-10-24 practice round found missing or
// wrong (plan mcp-practice-fixups-3, item F). Each note is generated where the
// rest of the catalog's notes are, so these pin the sentences a client reads.

import { describe, it, expect } from 'vitest'
import { MUTATION_CATALOG, mutationInfoOf } from '../mutationCatalog'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import type { Mutation } from '@/types/cad'

// Every note text of every row: the row note plus each field note.
function allNotes(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [type, row] of Object.entries(MUTATION_CATALOG) as Array<[string, { note?: string; fields: Record<string, { note?: string }> }]>) {
    if (row.note !== undefined) out.push([type, row.note])
    for (const [field, info] of Object.entries(row.fields)) {
      if (info.note !== undefined) out.push([`${type}.${field}`, info.note])
    }
  }
  return out
}

describe('F1: constraint kinds named in notes', () => {
  it('lists exactly the registry kinds on add_constraint', () => {
    const note = mutationInfoOf('add_constraint').fields.kind.note!
    const listed = /one of: ([^.]+)\./.exec(note)![1].split(', ')
    expect(listed).toEqual([...CONSTRAINT_BY_KIND.keys()])
  })

  it('names no constraint kind the validator refuses', () => {
    // A backticked word right after "kind" or a "constraint kind ... e.g." phrase
    // is a constraint kind the note recommends.
    for (const [where, note] of allNotes()) {
      if (!/constraint/i.test(note)) continue
      for (const match of note.matchAll(/`([a-z_]+)`/g)) {
        const word = match[1]
        if (/kind|dimension|take/.test(note.slice(Math.max(0, match.index! - 40), match.index!))) {
          expect(CONSTRAINT_BY_KIND.has(word), `${where}: ${word}`).toBe(true)
        }
      }
    }
  })
})

describe('F2: apply_offset side', () => {
  it('states the side relative to the loop', () => {
    const note = mutationInfoOf('apply_offset' as Mutation['type']).note!
    expect(note).toContain('out of the region')
    expect(note).toContain('whatever the winding')
    expect(note).toContain('open selection')
  })
})
