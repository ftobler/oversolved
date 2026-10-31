import { describe, it, expect, beforeEach } from 'vitest'
import { IdbCarrier } from '../idbCarrier'
import type { WorkspaceTree } from '../types'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

const assemblyText = (partId: string): string =>
  `kind: assembly\nfeatures:\n  - kind: part_instance\n    instance:\n      handle: h1\n      doc_id: ${partId}\n      doc_rev: 1\n`

// References, trash and provenance live only on the workspace meta row, so a
// discard that restored the entry rows alone would put the text of the last
// save back while keeping the structure of the edits it threw away.
describe('discard restores the meta row the checkpoint adopted', () => {
  beforeEach(resetWorkspaceIdb)

  async function checkpointedCarrier(): Promise<IdbCarrier> {
    const tree: WorkspaceTree = treeWith([
      documentEntry('p', 'Part', { text: 'kind: part\n# v1\n' }),
      fileEntry('f', 'b.step', bytesOf([1, 2, 3])),
      documentEntry('asm', 'Gearbox', { docKind: 'assembly', text: assemblyText('p') }),
    ], 'ws-meta')
    tree.manifest.references = { asm: ['f', 'p'] }
    tree.manifest.provenance = [{ entry: 'f', origin: 'folder:cad', originEntry: 'b.step', originName: 'cad' }]
    await seedWorkspace(tree)
    const carrier = new IdbCarrier('ws-meta')
    await carrier.save(tree)
    await carrier.checkpoint()
    return carrier
  }

  it('puts back the references, trash and provenance of the checkpoint', async () => {
    const carrier = await checkpointedCarrier()
    const atCheckpoint = await carrier.open()

    // A whole working-copy edit that the checkpoint never adopted: the assembly
    // drops the part edge, the part is trashed and the provenance is gone.
    const edited = await carrier.open()
    edited.contents.set('asm', { text: 'kind: assembly\nfeatures: []\n' })
    delete edited.manifest.references.asm
    edited.manifest.provenance = []
    edited.manifest.trash = ['p']
    await carrier.save(edited)
    expect((await carrier.open()).manifest.trash).toEqual(['p'])

    const restored = await carrier.discard()

    expect(restored.contents.get('asm')?.text).toBe(assemblyText('p'))
    expect(restored.manifest.references).toEqual(atCheckpoint.manifest.references)
    expect(restored.manifest.trash).toEqual(atCheckpoint.manifest.trash)
    expect(restored.manifest.provenance).toEqual(atCheckpoint.manifest.provenance)
  })

  it('rebuilds the delete guard from the restored edges', async () => {
    const carrier = await checkpointedCarrier()
    const edited = await carrier.open()
    delete edited.manifest.references.asm
    await carrier.save(edited)
    expect(await carrier.referencesOf('asm')).toEqual([])

    await carrier.discard()

    expect(await carrier.referencesOf('asm')).toEqual(['f', 'p'])
  })
})
