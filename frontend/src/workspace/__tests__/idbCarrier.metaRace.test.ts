import { describe, it, expect, beforeEach } from 'vitest'
import { IdbCarrier } from '../idbCarrier'
import type { WorkspaceEntry } from '../types'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

async function makeCarrier(entries: WorkspaceEntry[]): Promise<IdbCarrier> {
  const tree = treeWith(entries)
  await seedWorkspace(tree)
  const carrier = new IdbCarrier(tree.manifest.workspace)
  await carrier.save(tree)
  return carrier
}

// The meta row is one record for the whole workspace, so two structure edits
// that each read it and then write it back would lose one of the two. Both
// edits are started without an await between them to interleave their reads and
// writes, which is what a delete and an edge reconcile from two editors do.
describe('concurrent workspace meta edits', () => {
  beforeEach(resetWorkspaceIdb)

  it('keeps a trashed entry and a new edge when they interleave', async () => {
    const carrier = await makeCarrier([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n' }),
      documentEntry('c', 'C', { text: 'kind: part\n' }),
    ])

    await Promise.all([carrier.remove('a'), carrier.addReference('b', 'c')])

    expect((await carrier.open()).manifest.trash).toEqual(['a'])
    expect(await carrier.referencesOf('b')).toEqual(['c'])
  })

  it('keeps a restore and an edge removal when they interleave', async () => {
    const carrier = await makeCarrier([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n' }),
      documentEntry('c', 'C', { text: 'kind: part\n' }),
    ])
    await carrier.addReference('b', 'c')
    await carrier.remove('a')

    await Promise.all([carrier.restore('a'), carrier.removeReference('b', 'c')])

    const tree = await carrier.open()
    expect(tree.manifest.trash).toEqual([])
    expect(tree.manifest.references.b).toBeUndefined()
  })
})
