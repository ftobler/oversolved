// The mutation example registry's own contract: it covers the full Mutation
// union, and every example really changes the document when its handler runs.
// The two declared exceptions are the label-only carriers (edit_session,
// preview_commit), whose appliers write nothing, and set_rollback, whose doc
// write comes from usePartDoc's rollback mirror rather than its no-op applier;
// the hook-level effect of every entry is proven by historyProperties.test.ts.
import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { MUTATION_EXAMPLES } from './mutationExamples'
import type { Mutation, PartDoc } from '@/types/cad'

type AnyHandler = (doc: PartDoc, m: Mutation) => void

function applyHandler(doc: PartDoc, mutation: Mutation): void {
  const handler = (mutationHandlers as Record<string, AnyHandler | undefined>)[mutation.type]
  if (!handler) throw new Error(`no handler for ${mutation.type}`)
  handler(doc, mutation)
}

const entries = Object.entries(MUTATION_EXAMPLES)

describe('mutation example registry', () => {
  it('covers exactly the types the dispatch table handles', () => {
    // The exhaustive dispatch suite pins the handler table to its literal list
    // of all Mutation types, so comparing against the table is the same
    // completeness fact without importing one test file from another or
    // keeping a second copy of the list.
    expect(Object.keys(MUTATION_EXAMPLES).sort()).toEqual(Object.keys(mutationHandlers).sort())
    expect(entries).toHaveLength(104)
  })

  it('declares exactly the label-only carriers', () => {
    const labelOnly = entries.filter(([, e]) => e.labelOnly).map(([type]) => type).sort()
    expect(labelOnly).toEqual(['edit_session', 'preview_commit'])
  })

  it.each(entries)('%s: the handler changes the document', (type, example) => {
    if (example.labelOnly || type === 'set_rollback') return
    const next = cloneDocForUndo(example.makeDoc())
    applyHandler(next, example.mutation)
    expect(next).not.toEqual(example.makeDoc())
  })

  it.each(entries)('%s: a label-only or mirror-written example is an identity no-op', (type, example) => {
    if (!example.labelOnly && type !== 'set_rollback') return
    const next = cloneDocForUndo(example.makeDoc())
    applyHandler(next, example.mutation)
    expect(next).toEqual(example.makeDoc())
  })

  it('every example mutation carries the key its table entry names', () => {
    for (const [type, example] of entries) {
      expect(example.mutation.type, type).toBe(type)
    }
  })
})
