// The assembly end-to-end path: a data command is parsed by the registry, the
// spec hands the parsed params to AssemblyCommandContext.runOperation, and the
// page's delegation to the real runAssemblyOperation appends to the document.
// The page's runOperation is exactly `runAssemblyOperation(id, payload, host)`
// with the live doc and the mutation/solve effects, so the fixture host below
// is the page's wiring with the store replaced.
import { describe, it, expect, vi } from 'vitest'
import { ASSEMBLY_COMMAND_SPECS, type AssemblyCommandContext } from '@/pages/assemblyCommandEntries'
import { CommandRegistry } from '@/utils/core/commandSpec'
import { runAssemblyOperation, type AssemblyOperationId, type AssemblyOperationInputs } from '@/utils/assemblyOperations'
import type { AssemblyDoc } from '@/types/cad'
import { assemblyContext } from './commandFixtures'

describe('assembly command integration: add_part end to end', () => {
  it('runs through the registry into the real operation, appends the instance and requests the solve', () => {
    let doc: AssemblyDoc = { version: 1, kind: 'assembly', features: [] }
    const effects: string[] = []
    const runOperation = vi.fn(<K extends AssemblyOperationId>(id: K, payload: AssemblyOperationInputs[K]) => {
      runAssemblyOperation(id, payload, {
        doc,
        transforms: {},
        mutateSession: (_label, apply) => { doc = apply(doc) },
        mutateOneShot: (_label, apply) => { doc = apply(doc) },
        requestSolve: () => { effects.push('solve') },
        requestSolveOrDefer: () => { effects.push('defer') },
      })
    })
    const registry = new CommandRegistry<AssemblyCommandContext>(() => assemblyContext({ runOperation }))
    for (const spec of ASSEMBLY_COMMAND_SPECS) registry.register(spec)

    const result = registry.execute('add_part', { docId: 'part-1', docRev: 5 })

    expect(result).toEqual({ ok: true, createdIds: [] })
    // The parsed params, not a raw payload, reached the page's operation path.
    expect(runOperation).toHaveBeenCalledWith('add_part', { docId: 'part-1', docRev: 5 })
    // The document changed: one part instance pointing at the picked document.
    const instances = (doc.features ?? []).filter(f => f.kind === 'part_instance')
    expect(instances).toHaveLength(1)
    expect(instances[0].instance).toMatchObject({ doc_id: 'part-1', doc_rev: 5 })
    // The operation's solve cell is what the page host turns into a request.
    expect(effects).toEqual(['solve'])
  })
})
