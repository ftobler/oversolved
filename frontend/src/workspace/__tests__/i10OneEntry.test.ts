import { describe, it, expect, beforeEach } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { appendPartInstance } from '@/utils/assemblyMutations'
import type { AssemblyDoc } from '@/types/cad'
import { resetWorkspaceIdb } from './idbHarness'

// I10: a linked part is one entry, not N copies (A3). Two assemblies that both
// name one part must converge on the single document entry rather than each
// dragging in a copy of it.
describe('I10: a linked part is one entry', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
  })

  it('keeps one part entry for two assemblies and points both edges at it', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })

    for (const id of ['asm-1', 'asm-2']) {
      const doc: AssemblyDoc = { kind: 'assembly', features: [] }
      await store.addEntry(workspace, {
        id, kind: 'document', name: id, docKind: 'assembly',
        text: stringifyYaml(appendPartInstance(doc, workspace, 1)),
      })
    }

    // Export and reopen through the carrier to exercise persistence as well as
    // the live working copy.
    const opened = await store.open(workspace)
    await store.save(workspace, opened.tree)

    const entries = await store.listEntries(workspace)
    expect(entries.filter(entry => entry.kind === 'document' && entry.docKind === 'part')).toHaveLength(1)

    const carrier = new IdbCarrier(workspace)
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])
    expect(await carrier.referencesOf('asm-2')).toEqual([workspace])
  })
})
