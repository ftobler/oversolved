import { describe, it, expect, beforeEach } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { appendPartInstance } from '@/utils/assemblyMutations'
import type { AssemblyDoc } from '@/types/cad'
import { resetWorkspaceIdb } from './idbHarness'

// I3: entries are addressed by uuid, path is display. Renaming a part changes
// its name and path but not a single byte of the manifest's reference edges, so
// the assembly that names it still resolves.
describe('I3: rename stability', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
  })

  it('leaves every reference edge unchanged and keeps the part resolvable', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    const doc: AssemblyDoc = { kind: 'assembly', features: [] }
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly',
      text: stringifyYaml(appendPartInstance(doc, workspace, 1)),
    })

    const carrier = new IdbCarrier(workspace)
    const before = await carrier.referencesMap()

    await store.renameEntry(workspace, workspace, 'Bracket A')

    const after = await carrier.referencesMap()
    expect(after).toEqual(before)

    // The part keeps its uuid, the assembly still names it, and the rename is
    // visible as display only.
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])
    const part = await store.readEntry(workspace, workspace)
    expect(part.name).toBe('Bracket A')
    expect(part.text).toBe('')
    const assembly = await store.readEntry(workspace, 'asm-1')
    expect(assembly.text).toContain(workspace)
  })
})
