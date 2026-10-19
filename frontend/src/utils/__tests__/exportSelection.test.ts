import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  DEFAULT_EXPORT_SELECTION,
  exportHasOutput,
  planExport,
  selectedParts,
  zipExportFiles,
  type ExportPart,
  type ExportSelection,
} from '../exportSelection'

const PARTS: ExportPart[] = [
  { id: 'h1', name: 'Bracket' },
  { id: 'h2', name: 'Bracket' },
  { id: 'h3', name: 'Motor Mount' },
]

const SELECTED: ExportSelection = {
  scope: 'selected',
  bundle: 'consolidated',
  selectedIds: ['h1', 'h3'],
}

describe('selectedParts', () => {
  it('covers every part in all scope', () => {
    expect(selectedParts(PARTS, DEFAULT_EXPORT_SELECTION).map(p => p.id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('keeps only the selected ids, in part order', () => {
    expect(selectedParts(PARTS, { ...SELECTED, selectedIds: ['h3', 'h1'] }).map(p => p.id))
      .toEqual(['h1', 'h3'])
  })
})

describe('exportHasOutput', () => {
  it('is true for all scope and for a non-empty document selection', () => {
    expect(exportHasOutput(PARTS, DEFAULT_EXPORT_SELECTION)).toBe(true)
    expect(exportHasOutput(PARTS, { ...SELECTED, selectedIds: ['h2'] })).toBe(true)
  })

  it('is false when the selected ids name no part in this list', () => {
    expect(exportHasOutput(PARTS, { ...SELECTED, selectedIds: [] })).toBe(false)
    expect(exportHasOutput(PARTS, { ...SELECTED, selectedIds: ['gone'] })).toBe(false)
  })
})

describe('planExport', () => {
  it('all parts in one consolidated file, named by the dialog', () => {
    expect(planExport(PARTS, DEFAULT_EXPORT_SELECTION, 'step', 'assembly.step')).toEqual([
      { name: 'assembly.step', partIds: ['h1', 'h2', 'h3'] },
    ])
  })

  it('selected consolidated is one file covering only the selected parts', () => {
    expect(planExport(PARTS, SELECTED, 'stl', 'assembly.stl')).toEqual([
      { name: 'assembly.stl', partIds: ['h1', 'h3'] },
    ])
  })

  it('zip is one entry per chosen part, named after the part', () => {
    expect(planExport(PARTS, { ...SELECTED, bundle: 'zip' }, 'stl', 'assembly.stl')).toEqual([
      { name: 'Bracket.stl', partIds: ['h1'] },
      { name: 'Motor_Mount.stl', partIds: ['h3'] },
    ])
  })

  it('keeps a one-entry zip when the user chose the zip bundle', () => {
    expect(planExport(PARTS, { ...SELECTED, bundle: 'zip', selectedIds: ['h2'] }, 'step', 'a.step')).toEqual([
      { name: 'Bracket.step', partIds: ['h2'] },
    ])
  })

  it('disambiguates duplicate part names deterministically', () => {
    const selection: ExportSelection = { scope: 'all', bundle: 'zip', selectedIds: [] }
    const first = planExport(PARTS, selection, 'stl', 'assembly.stl')
    const again = planExport(PARTS, selection, 'stl', 'assembly.stl')
    expect(first.map(f => f.name)).toEqual(['Bracket.stl', 'Bracket (2).stl', 'Motor_Mount.stl'])
    expect(again).toEqual(first)
  })

  it('flattens path separators and parent segments so entries stay in the archive', () => {
    const parts: ExportPart[] = [
      { id: 'x', name: 'a/../b' },
      { id: 'y', name: '..\\..\\etc' },
    ]
    const files = planExport(parts, { ...SELECTED, bundle: 'zip', selectedIds: ['x', 'y'] }, 'stl', 'asm.stl')
    for (const file of files) {
      expect(file.name).not.toMatch(/[\\/]/)
      expect(file.name).not.toContain('..')
    }
    expect(new Set(files.map(f => f.name)).size).toBe(2)
  })

  it('yields no files for an empty selection', () => {
    expect(planExport(PARTS, { ...SELECTED, selectedIds: [] }, 'stl', 'a.stl')).toEqual([])
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
