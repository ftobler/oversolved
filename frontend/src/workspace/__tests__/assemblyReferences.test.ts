import { describe, it, expect, beforeEach } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { appendPartInstance, removeInstance } from '@/utils/assemblyMutations'
import type { AssemblyDoc } from '@/types/cad'
import { resetWorkspaceIdb } from './idbHarness'

// The assembly's outgoing document-to-document edges are content-driven: they
// are read back out of the document text on every write, so an append and its
// undo move the edge set with the text and nothing has to be unwound.
describe('content-driven assembly reference edges', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
  })

  async function seedAssembly(store: IdbWorkspaceStore, workspace: string, doc: AssemblyDoc): Promise<void> {
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: stringifyYaml(doc),
    })
  }

  async function writeAssembly(store: IdbWorkspaceStore, workspace: string, doc: AssemblyDoc): Promise<void> {
    await store.writeEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: stringifyYaml(doc),
    })
  }

  it('records a part edge on append and drops it on the undo that removes the instance', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    const carrier = new IdbCarrier(workspace)

    const empty: AssemblyDoc = { kind: 'assembly', features: [] }
    await seedAssembly(store, workspace, empty)
    expect(await carrier.referencesOf('asm-1')).toEqual([])

    // Append a part instance, then write the text: the edge appears.
    const appended = appendPartInstance(empty, workspace, 1)
    await writeAssembly(store, workspace, appended)
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])

    // Undo is just the previous text: the edge leaves with it.
    const handle = appended.features![0].instance!.handle
    const undone = removeInstance(appended, handle)
    await writeAssembly(store, workspace, undone)
    expect(await carrier.referencesOf('asm-1')).toEqual([])
  })

  it('reconciles the edge set to the text on a full rewrite', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    const carrier = new IdbCarrier(workspace)

    await seedAssembly(store, workspace, appendPartInstance({ kind: 'assembly', features: [] }, workspace, 1))
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])

    await writeAssembly(store, workspace, { kind: 'assembly', features: [] })
    expect(await carrier.referencesOf('asm-1')).toEqual([])
  })
})
