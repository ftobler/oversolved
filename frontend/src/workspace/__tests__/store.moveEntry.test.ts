import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { STORE_WORKSPACE_META } from '@/persistence/idb'
import { getPreviewStore } from '@/persistence/previewStore'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { EntryMoveRefusedError } from '../errors'
import { resetWorkspaceIdb } from './idbHarness'

const partText = (fileId: string): string =>
  `kind: part\nfeatures:\n  - id: imp1\n    kind: import_step\n    file_id: ${fileId}\n`

const assemblyText = (...parts: string[]): string =>
  'kind: assembly\nfeatures:\n' + parts.map((id, i) =>
    `  - kind: part_instance\n    instance:\n      handle: h${i}\n      doc_id: ${id}\n      doc_rev: 1\n`).join('')

const bytes = (n: number) => new Uint8Array([n, n + 1, n + 2])

// frame uses plate and stud, frame-2 uses stud too; each part imports its STEP.
async function seedShop(store: IdbWorkspaceStore): Promise<{ from: string; to: string }> {
  const { workspace: from } = await store.create('Bench', { docKind: 'part' })
  const { workspace: to } = await store.create('Shop', { docKind: 'part' })
  for (const [id, n] of [['plate.step', 1], ['stud.step', 5]] as const) {
    await store.addEntry(from, { id, kind: 'file', name: id, mime: 'application/step', fileKind: 'step', bytes: bytes(n) })
  }
  await store.addEntry(from, { id: 'plate', kind: 'document', name: 'plate', docKind: 'part', text: partText('plate.step') })
  await store.addEntry(from, { id: 'stud', kind: 'document', name: 'stud', docKind: 'part', text: partText('stud.step') })
  await store.addEntry(from, { id: 'frame', kind: 'document', name: 'frame', docKind: 'assembly', text: assemblyText('plate', 'stud') })
  await store.addEntry(from, { id: 'frame-2', kind: 'document', name: 'frame-2', docKind: 'assembly', text: assemblyText('stud') })
  return { from, to }
}

const ids = async (store: IdbWorkspaceStore, workspace: string, includeTrashed = false) =>
  (await store.listEntries(workspace, { includeTrashed })).map(entry => entry.id).sort()

const originalPut = IDBObjectStore.prototype.put

describe('IdbWorkspaceStore.moveEntry', () => {
  beforeEach(resetWorkspaceIdb)
  afterEach(() => {
    IDBObjectStore.prototype.put = originalPut
  })

  it('moves a lone part with its STEP file, keeping ids, edges and bytes, and drops them from the source for good', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace: from } = await store.create('Bench', { docKind: 'part' })
    const { workspace: to } = await store.create('Shop', { docKind: 'part' })
    await store.addEntry(from, { id: 'f', kind: 'file', name: 'bracket.step', mime: 'application/step', bytes: bytes(7) })
    await store.addEntry(from, { id: 'p', kind: 'document', name: 'bracket', docKind: 'part', text: partText('f') })

    const report = await store.moveEntry(from, 'p', to)

    expect(report).toEqual({
      target: 'Shop',
      moved: [{ id: 'p', name: 'bracket', kind: 'document' }, { id: 'f', name: 'bracket.step', kind: 'file' }],
      copied: [],
    })
    expect(await ids(store, to)).toEqual(['f', 'p', to].sort())
    expect(await new IdbCarrier(to).referencesOf('p')).toEqual(['f'])
    expect((await store.readEntry(to, 'p')).text).toBe(partText('f'))
    expect(Array.from((await store.readEntry(to, 'f')).bytes ?? [])).toEqual([7, 8, 9])
    // A hard removal: not listed, and not in the trash either.
    expect(await ids(store, from, true)).toEqual([from])
    expect(await new IdbCarrier(from).referencesOf('p')).toEqual([])
  })

  it('moves an assembly with its exclusive part, copies the shared one, and resolves in the target', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)

    const report = await store.moveEntry(from, 'frame', to)

    expect(report.moved.map(row => row.id)).toEqual(['frame', 'plate', 'plate.step'])
    expect(report.copied.map(row => row.id)).toEqual(['stud', 'stud.step'])
    expect(await ids(store, to)).toEqual(['frame', 'plate', 'plate.step', 'stud', 'stud.step', to].sort())
    // The source keeps the shared part and the file it still imports.
    expect(await ids(store, from, true)).toEqual(['frame-2', 'stud', 'stud.step', from].sort())
    expect(await new IdbCarrier(from).referencesOf('stud')).toEqual(['stud.step'])
    // Every edge the assembly needs resolves to a row the target holds.
    const opened = await store.open(to)
    expect(opened.tree.manifest.references.frame).toEqual(['plate', 'stud'])
    expect(opened.tree.manifest.references.plate).toEqual(['plate.step'])
    for (const target of ['plate', 'stud', 'plate.step', 'stud.step']) {
      expect(opened.tree.manifest.entries[target]).toBeDefined()
    }
    expect(opened.tree.contents.get('frame')?.text).toBe(assemblyText('plate', 'stud'))
  })

  it('refuses a part an assembly uses, by name, and changes nothing', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    const before = await ids(store, from)

    await expect(store.moveEntry(from, 'plate', to)).rejects.toThrow(
      new EntryMoveRefusedError('plate is used by frame; move frame instead, or remove it from frame first.'),
    )
    expect(await ids(store, from)).toEqual(before)
    expect(await ids(store, to)).toEqual([to])
  })

  it('refuses an id the target already holds instead of overwriting it', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    await store.addEntry(to, { id: 'plate', kind: 'document', name: 'plate', docKind: 'part', text: 'kind: part\nfeatures: []\n' })

    const plan = await store.planMove(from, 'frame', to)
    expect(plan).toEqual({ ok: false, refused: 'Shop already has plate; delete it there first.' })
    await expect(store.moveEntry(from, 'frame', to)).rejects.toBeInstanceOf(EntryMoveRefusedError)
    expect((await store.readEntry(to, 'plate')).text).toBe('kind: part\nfeatures: []\n')
  })

  it('leaves both workspaces exactly as they were when a write in the unit fails', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    const sourceBefore = await store.open(from)
    const targetBefore = await store.open(to)

    // The meta rows are the last writes of the unit, issued after every target
    // row was added and every source row deleted, so this is the rollback case.
    const patched = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === STORE_WORKSPACE_META) throw new Error('injected meta failure')
      return (originalPut as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
    IDBObjectStore.prototype.put = patched as typeof IDBObjectStore.prototype.put
    await expect(store.moveEntry(from, 'frame', to)).rejects.toThrow('injected meta failure')
    IDBObjectStore.prototype.put = originalPut

    expect((await store.open(from)).tree).toEqual(sourceBefore.tree)
    expect((await store.open(to)).tree).toEqual(targetBefore.tree)
    expect(Array.from((await store.readEntry(from, 'plate.step')).bytes ?? [])).toEqual([1, 2, 3])
  })

  it('copies the previews and drops the moved ones from the source', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    await getPreviewStore().put(from, 'frame', 'frame-image')
    await getPreviewStore().put(from, 'stud', 'stud-image')

    await store.moveEntry(from, 'frame', to)

    expect(await getPreviewStore().get(to, 'frame')).toBe('frame-image')
    expect(await getPreviewStore().get(to, 'stud')).toBe('stud-image')
    expect(await getPreviewStore().get(from, 'frame')).toBeUndefined()
    // The copied part is still the source's own row, so its thumbnail stays.
    expect(await getPreviewStore().get(from, 'stud')).toBe('stud-image')
  })

  it('carries the save state: a saved entry is still saved in the target, and discard keeps it', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    await store.checkpoint(from)

    await store.moveEntry(from, 'frame', to)

    expect((await store.open(to)).ahead).toBe(false)
    expect((await store.open(from)).ahead).toBe(false)
    await store.discard(to)
    await store.discard(from)
    expect(await ids(store, to)).toEqual(['frame', 'plate', 'plate.step', 'stud', 'stud.step', to].sort())
    expect(await new IdbCarrier(to).referencesOf('frame')).toEqual(['plate', 'stud'])
    // A discard in the source cannot bring a moved row back from its checkpoint.
    expect(await ids(store, from, true)).toEqual(['frame-2', 'stud', 'stud.step', from].sort())
  })

  it('keeps an unsaved edit unsaved', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    await store.checkpoint(from)
    await store.writeEntry(from, { id: 'plate', kind: 'document', name: 'plate', docKind: 'part', text: partText('plate.step') + '# edited\n' })

    await store.moveEntry(from, 'frame', to)

    expect((await store.open(to)).ahead).toBe(true)
    expect((await store.open(from)).ahead).toBe(false)
    await store.discard(to)
    expect((await store.readEntry(to, 'plate')).text).toBe(partText('plate.step'))
  })

  it('refuses a confirmed plan the workspace has since outgrown', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    const confirmed = await store.planMove(from, 'frame', to)
    if (!confirmed.ok) throw new Error(confirmed.refused)
    // frame-2 stops using stud, so stud would now move instead of being copied.
    await store.writeEntry(from, { id: 'frame-2', kind: 'document', name: 'frame-2', docKind: 'assembly', text: assemblyText() })

    await expect(store.moveEntry(from, 'frame', to, confirmed)).rejects.toBeInstanceOf(EntryMoveRefusedError)
    expect(await ids(store, to)).toEqual([to])
  })

  it('names a row the target gained after the plan instead of a raw storage error', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    const stale = await store.planMove(from, 'frame', to)
    await store.addEntry(to, { id: 'plate', kind: 'document', name: 'plate', docKind: 'part', text: 'kind: part\nfeatures: []\n' })
    // The store re-plans inside moveEntry; hand it the stale answer, as a race
    // between the plan read and the transaction would.
    vi.spyOn(store, 'planMove').mockResolvedValue(stale)

    await expect(store.moveEntry(from, 'frame', to)).rejects.toThrow(
      new EntryMoveRefusedError('Shop gained one of these entries since the move was planned; pick the target again.'),
    )
    expect(await ids(store, from)).toContain('frame')
    expect((await store.readEntry(to, 'plate')).text).toBe('kind: part\nfeatures: []\n')
  })

  it('moves the source cover choice away with its entry', async () => {
    const store = new IdbWorkspaceStore()
    const { from, to } = await seedShop(store)
    await store.setCover(from, 'frame')

    await store.moveEntry(from, 'frame', to)

    const summary = (await store.list()).find(row => row.workspace === from)
    expect(summary?.coverChoice).toBeUndefined()
    expect(summary?.coverEntry).not.toBe('frame')
  })
})
