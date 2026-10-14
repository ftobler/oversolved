import { describe, it, expect } from 'vitest'
import {
  buildCommandRows, extractCommandTable, renderCommandTable, replaceCommandTable,
  COMMAND_TABLE_END, COMMAND_TABLE_START,
} from '@/pages/registry/commandRows'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { ASSEMBLY_COMMAND_SPECS } from '@/pages/assemblyCommandEntries'
import { COMMAND_NAMES } from '@/utils/core/commandNames'

// The Registry page is the user-facing contract for commands, exactly as the
// keybindings table is for keys. A row set that misses a spec (or advertises
// one that does not exist) is an advertised lie, so the row set is checked
// against the union field by field.

const rows = buildCommandRows()

describe('buildCommandRows', () => {
  it('every spec has a row and no row is duplicated', () => {
    const ids = rows.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const expected = new Set([
      ...PART_COMMAND_SPECS.map(s => s.id),
      ...ASSEMBLY_COMMAND_SPECS.map(s => s.id),
    ])
    expect(new Set(ids)).toEqual(expected)
  })

  it('covers exactly the COMMAND_NAMES union', () => {
    expect(new Set(rows.map(r => r.id))).toEqual(new Set(COMMAND_NAMES))
  })

  it('labels both editors on the shared names and one editor on the rest', () => {
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId.undo.editor).toBe('both')
    expect(byId.redo.editor).toBe('both')
    expect(byId.delete_selected.editor).toBe('both')
    expect(byId.cancel_draw.editor).toBe('sketch/part')
    expect(byId.cancel_edit.editor).toBe('assembly')
    expect(byId.insert_mate_fixed.editor).toBe('assembly')
    expect(byId.apply_offset.editor).toBe('sketch/part')
  })

  it('every row carries a label and a shortcut string', () => {
    for (const row of rows) {
      expect(row.label.length, `label missing for "${row.id}"`).toBeGreaterThan(0)
      expect(typeof row.shortcut).toBe('string')
    }
  })

  it('mirrors the spec shortcut and undoable flags', () => {
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId.undo.shortcut).toBe('ctrl+z')
    expect(byId.redo.shortcut).toBe('ctrl+shift+z')
    expect(byId.apply_horizontal.shortcut).toBe('h')
    expect(byId.add_extrude.shortcut).toBe('e')
    expect(byId.apply_offset.shortcut).toBe('')
    expect(byId.undo.undoable).toBe(false)
    expect(byId.add_extrude.undoable).toBe(true)
    expect(byId.insert_mate_fixed.undoable).toBe(true)
  })
})

describe('docs table block', () => {
  it('renders one markdown row per command between the markers', () => {
    const block = renderCommandTable()
    const body = block.slice(COMMAND_TABLE_START.length, block.length - COMMAND_TABLE_END.length)
    const dataRows = body.split('\n').filter(line => line.startsWith('| `'))
    expect(dataRows).toHaveLength(rows.length)
  })

  it('replace/extract round-trips against a docs body', () => {
    const docs = `intro\n\n${COMMAND_TABLE_START}\nstale\n${COMMAND_TABLE_END}\n\nrest\n`
    const block = renderCommandTable()
    const next = replaceCommandTable(docs, block)
    expect(next).not.toBeNull()
    expect(extractCommandTable(next!)).toBe(block)
    expect(next).toContain('intro')
    expect(next).toContain('rest')
  })

  it('returns null when the markers are missing', () => {
    expect(replaceCommandTable('no table here', 'x')).toBeNull()
    expect(extractCommandTable('no table here')).toBeNull()
  })
})
