import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  DEFAULT_EXPORT_SELECTION,
  exportHasOutput,
  planExport,
  selectedParts,
  zipExportFiles,
  type ExportPart,
} from '../exportSelection'

const PARTS: ExportPart[] = [
  { id: 'h1', name: 'Bracket' },
  { id: 'h2', name: 'Bracket' },
  { id: 'h3', name: 'Motor Mount' },
]

describe('selectedParts', () => {
  it('covers every part in everything mode', () => {
    expect(selectedParts(PARTS, DEFAULT_EXPORT_SELECTION).map(p => p.id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('keeps only the ticked ids, in part order', () => {
    expect(selectedParts(PARTS, { mode: 'selected', selectedIds: ['h3', 'h1'] }).map(p => p.id))
      .toEqual(['h1', 'h3'])
  })
})

describe('exportHasOutput', () => {
  it('is true for everything and for a non-empty tick set', () => {
    expect(exportHasOutput(PARTS, DEFAULT_EXPORT_SELECTION)).toBe(true)
    expect(exportHasOutput(PARTS, { mode: 'selected', selectedIds: ['h2'] })).toBe(true)
  })

  it('is false when a selection mode has nothing ticked', () => {
    expect(exportHasOutput(PARTS, { mode: 'selected', selectedIds: [] })).toBe(false)
    expect(exportHasOutput(PARTS, { mode: 'separate', selectedIds: [] })).toBe(false)
  })
})

describe('planExport', () => {
  it('everything is one file covering all parts, named by the dialog', () => {
    expect(planExport(PARTS, DEFAULT_EXPORT_SELECTION, 'step', 'assembly.step')).toEqual([
      { name: 'assembly.step', partIds: ['h1', 'h2', 'h3'] },
    ])
  })

  it('selected is one file covering only the ticked parts', () => {
    expect(planExport(PARTS, { mode: 'selected', selectedIds: ['h1', 'h3'] }, 'stl', 'assembly.stl')).toEqual([
      { name: 'assembly.stl', partIds: ['h1', 'h3'] },
    ])
  })

  it('separate is one file per ticked part, named after the part', () => {
    expect(planExport(PARTS, { mode: 'separate', selectedIds: ['h1', 'h3'] }, 'stl', 'assembly.stl')).toEqual([
      { name: 'Bracket.stl', partIds: ['h1'] },
      { name: 'Motor_Mount.stl', partIds: ['h3'] },
    ])
  })

  it('disambiguates duplicate part names deterministically', () => {
    const selection = { mode: 'separate' as const, selectedIds: ['h1', 'h2', 'h3'] }
    const first = planExport(PARTS, selection, 'stl', 'assembly.stl')
    const again = planExport(PARTS, selection, 'stl', 'assembly.stl')
    expect(first.map(f => f.name)).toEqual(['Bracket.stl', 'Bracket (2).stl', 'Motor_Mount.stl'])
    expect(again).toEqual(first)
  })

  it('yields no files for an empty selection', () => {
    expect(planExport(PARTS, { mode: 'separate', selectedIds: [] }, 'stl', 'a.stl')).toEqual([])
  })
})

describe('zipExportFiles', () => {
  it('bundles one entry per file, keeping the names', async () => {
    const bytes = await zipExportFiles([
      { name: 'Bracket.stl', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'Bracket (2).stl', bytes: new Uint8Array([4, 5]) },
    ])
    const zip = await JSZip.loadAsync(bytes)
    expect(Object.keys(zip.files).sort()).toEqual(['Bracket (2).stl', 'Bracket.stl'])
    expect(Array.from(await zip.file('Bracket.stl')!.async('uint8array'))).toEqual([1, 2, 3])
    expect(Array.from(await zip.file('Bracket (2).stl')!.async('uint8array'))).toEqual([4, 5])
  })
})
