import { describe, it, expect } from 'vitest'
import { resolveCoverEntry } from '../cover'
import type { EntryKind } from '../types'
import type { WorkspaceEntryMetaRecord } from '../idbCarrier'

// The cover is one entry id, resolved from a stored choice plus the live rows.
// `live` is already the not-trashed set, so the resolver never reads the trash.

function row(
  id: string,
  options: { kind?: EntryKind; docKind?: string; updatedAt?: number } = {},
): WorkspaceEntryMetaRecord {
  const record: WorkspaceEntryMetaRecord = {
    workspace: 'ws',
    id,
    path: `documents/${id}.yaml`,
    kind: options.kind ?? 'document',
    name: id,
    rev: 1,
    updatedAt: options.updatedAt ?? 0,
    contentHash: 'h',
    size: 0,
  }
  if (options.docKind !== undefined) record.docKind = options.docKind
  return record
}

describe('resolveCoverEntry', () => {
  it('takes the explicit choice while it is a live document', () => {
    const live = [
      row('asm', { docKind: 'assembly', updatedAt: 90 }),
      row('part', { docKind: 'part', updatedAt: 80 }),
    ]
    expect(resolveCoverEntry({ cover: 'part' }, live)).toBe('part')
  })

  // Trashing the cover entry drops it from the live set; the stored id is kept,
  // so restoring the entry brings the same cover back without a second write.
  it('falls back automatically while the explicit choice is not live', () => {
    const live = [row('asm', { docKind: 'assembly', updatedAt: 90 })]
    expect(resolveCoverEntry({ cover: 'trashed' }, live)).toBe('asm')
  })

  it('ignores an explicit choice that names a file', () => {
    const live = [
      row('file', { kind: 'file', updatedAt: 99 }),
      row('part', { docKind: 'part', updatedAt: 10 }),
    ]
    expect(resolveCoverEntry({ cover: 'file' }, live)).toBe('part')
  })

  // The report this feature came from: the old rule took the first document by
  // id, so an assembly was only ever the cover by luck. A file is not a document
  // and can never stand for the workspace.
  it('prefers an assembly over a newer part', () => {
    const live = [
      row('part', { docKind: 'part', updatedAt: 100 }),
      row('asm', { docKind: 'assembly', updatedAt: 1 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('asm')
  })

  it('takes the newest assembly of several', () => {
    const live = [
      row('asm-old', { docKind: 'assembly', updatedAt: 1 }),
      row('asm-new', { docKind: 'assembly', updatedAt: 2 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('asm-new')
  })

  it('takes the newest part when there is no assembly', () => {
    const live = [
      row('part-old', { docKind: 'part', updatedAt: 1 }),
      row('part-new', { docKind: 'part', updatedAt: 2 }),
      row('file', { kind: 'file', updatedAt: 3 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('part-new')
  })

  it('prefers a part over a newer other document', () => {
    const live = [
      row('drawing', { docKind: 'drawing', updatedAt: 100 }),
      row('part', { docKind: 'part', updatedAt: 1 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('part')
  })

  it('takes the newest other document last', () => {
    const live = [
      row('drawing-old', { docKind: 'drawing', updatedAt: 1 }),
      row('drawing-new', { docKind: 'drawing', updatedAt: 2 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('drawing-new')
  })

  // A tie on time must not depend on the order the rows were read in, so the
  // lowest id wins: the same id the old "first document" rule picked.
  it('breaks a tie on id', () => {
    const live = [
      row('m', { docKind: 'part', updatedAt: 7 }),
      row('b', { docKind: 'part', updatedAt: 7 }),
    ]
    expect(resolveCoverEntry({}, live)).toBe('b')
    expect(resolveCoverEntry({}, [...live].reverse())).toBe('b')
  })

  it('gives undefined for an all-file workspace', () => {
    expect(resolveCoverEntry({}, [row('a', { kind: 'file' }), row('b', { kind: 'file' })])).toBeUndefined()
    expect(resolveCoverEntry({}, [])).toBeUndefined()
  })
})
