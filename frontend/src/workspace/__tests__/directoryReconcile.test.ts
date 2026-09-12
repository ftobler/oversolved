import { describe, it, expect } from 'vitest'
import { DirectoryCarrier } from '../directoryCarrier'
import { documentEntry, treeWith } from './fixtures'
import { fakeDirectory, type FakeDirectoryHandle } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The narrowed reconcile: presence and absence only. The manifest owns identity,
// so a file the app did not write is reported and never adopted, and an entry
// whose file vanished is reported and stays in the list.

describe('directory reconcile', () => {
  async function seeded() {
    const dir = fakeDirectory()
    const carrier = new DirectoryCarrier(dir)
    const tree = treeWith([documentEntry('a', 'A', { text: 'kind: part\n' })])
    await carrier.save(tree)
    const documents = await dir.getDirectoryHandle('documents') as unknown as FakeDirectoryHandle
    return { dir, carrier, documents }
  }

  it('reports a file the manifest does not name and never adopts it', async () => {
    const { carrier, documents } = await seeded()
    documents.putText('Extra.yaml', 'kind: assembly\n')

    const report = await carrier.reconcile()
    expect(report.unknownFiles).toContain('documents/Extra.yaml')
    const listed = await carrier.list()
    expect(listed.map(entry => entry.name)).toEqual(['A'])
  })

  it('reports a missing payload and keeps the entry in identity terms', async () => {
    const { carrier, documents } = await seeded()
    await documents.removeEntry('A.yaml')

    const report = await carrier.reconcile()
    expect(report.missing).toContain('a')
    const listed = await carrier.list()
    expect(listed.map(entry => entry.id)).toEqual(['a'])
  })

  // A manifest names the document; a git checkout or an outside delete removes
  // its file. open must surface the gap rather than substituting empty text,
  // which a carrier-change reload would otherwise write over the working copy.
  it('open refuses to blank a manifest-named document whose file is gone', async () => {
    const { carrier, documents } = await seeded()
    await documents.removeEntry('A.yaml')
    await expect(carrier.open()).rejects.toThrow(/missing/)
  })
})
