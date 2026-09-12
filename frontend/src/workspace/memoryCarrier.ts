import type { ListOptions, WorkspaceCarrier } from './carrier'
import type { EntryMeta, WorkspaceEntry, WorkspaceTree } from './types'
import { addEntry, assertTree, cloneTree, entryById, isTrashed, putEntry, removeEntry, restoreEntry } from './tree'
import { suggestedCloneName } from '@/stores/documentStore/cloneName'
import { randomUuid } from '@/utils/randomUuid'

// The in-memory conformer, written to the carrier seam rather than ported from
// a future implementation so the seam cannot rot with only one shape behind it.
// One WorkspaceTree lives on the instance; open and save deep-copy in and out.
export class MemoryCarrier implements WorkspaceCarrier {
  private tree?: WorkspaceTree

  constructor(tree?: WorkspaceTree) {
    if (tree) {
      assertTree(tree)
      this.tree = cloneTree(tree)
    }
  }

  async open(): Promise<WorkspaceTree> {
    return cloneTree(this.requireTree())
  }

  async save(tree: WorkspaceTree): Promise<void> {
    assertTree(tree)
    this.tree = cloneTree(tree)
  }

  async list(options: ListOptions = {}): Promise<EntryMeta[]> {
    const tree = this.requireTree()
    const out: EntryMeta[] = []
    for (const id of Object.keys(tree.manifest.entries).sort()) {
      if (!options.includeTrashed && isTrashed(tree, id)) continue
      const row = tree.manifest.entries[id]
      const meta: EntryMeta = { id, path: row.path, kind: row.kind, name: row.name }
      if (row.docKind !== undefined) meta.docKind = row.docKind
      if (row.mime !== undefined) meta.mime = row.mime
      if (row.fileKind !== undefined) meta.fileKind = row.fileKind
      out.push(meta)
    }
    return out
  }

  async read(id: string): Promise<WorkspaceEntry> {
    const tree = this.requireTree()
    if (isTrashed(tree, id)) throw new Error(`Entry is trashed: ${id}`)
    return entryById(tree, id)
  }

  async write(entry: WorkspaceEntry): Promise<void> {
    const tree = this.requireTree()
    if (!tree.manifest.entries[entry.id]) throw new Error(`Entry not found: ${entry.id}`)
    if (isTrashed(tree, entry.id)) throw new Error(`Entry is trashed: ${entry.id}`)
    putEntry(tree, entry)
    assertTree(tree)
  }

  async add(entry: WorkspaceEntry): Promise<void> {
    const tree = this.requireTree()
    addEntry(tree, entry)
    assertTree(tree)
  }

  async remove(id: string): Promise<void> {
    const tree = this.requireTree()
    removeEntry(tree, id)
    assertTree(tree)
  }

  async restore(id: string): Promise<void> {
    const tree = this.requireTree()
    restoreEntry(tree, id)
    assertTree(tree)
  }

  // A fresh uuid and a content copy; reference edges and provenance are link
  // semantics and stay with C2/C3.
  async clone(id: string, name?: string): Promise<string> {
    const tree = this.requireTree()
    const source = await this.read(id)
    const clone: WorkspaceEntry = {
      id: randomUuid(),
      kind: source.kind,
      name: name ?? suggestedCloneName(source.name),
      text: source.text,
      bytes: source.bytes,
    }
    if (source.docKind !== undefined) clone.docKind = source.docKind
    if (source.mime !== undefined) clone.mime = source.mime
    if (source.fileKind !== undefined) clone.fileKind = source.fileKind
    addEntry(tree, clone)
    assertTree(tree)
    return clone.id
  }

  private requireTree(): WorkspaceTree {
    if (!this.tree) throw new Error('Carrier is empty')
    return this.tree
  }
}
