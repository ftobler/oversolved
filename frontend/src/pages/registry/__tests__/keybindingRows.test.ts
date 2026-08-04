import { describe, it, expect } from 'vitest'
import { buildKeybindingRows, rowId, resolveMode, MODE_LABEL } from '@/pages/registry/keybindingRows'

// The Registry page is the user-facing contract for the keyboard. A row that no
// dispatch path can produce is an advertised lie (this is how `p` -> Parallel
// survived after plane visibility took the key), and a mode-split key listed
// twice with no mode shown is the same lie in a quieter form.

const rows = buildKeybindingRows()

describe('buildKeybindingRows', () => {
  it('no row is unreachable', () => {
    for (const r of rows) {
      expect(r.mode, `"${r.key}" -> "${r.command}" resolves in no mode`).not.toBe('none')
    }
  })

  it('row ids are unique, so React never sees a duplicate key', () => {
    const ids = rows.map(rowId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('labels the two halves of the e mode split', () => {
    const byCommand = Object.fromEntries(
      rows.filter(r => r.key === 'e').map(r => [r.command, r.mode]),
    )
    expect(byCommand).toEqual({
      add_extrude: 'feature',
      apply_equal_length: 'sketch',
    })
  })

  it('a key with no mode override is reachable in both modes', () => {
    expect(resolveMode('p', 'toggle_plane_visibility')).toBe('both')
    expect(resolveMode('ctrl+z', 'undo')).toBe('both')
    expect(rows.find(r => r.key === 'escape')!.mode).toBe('both')
  })

  it('reports a command that no keymap resolves as unreachable', () => {
    expect(resolveMode('p', 'apply_parallel')).toBe('none')
  })

  it('does not advertise parallel on p', () => {
    expect(rows.map(r => r.command)).not.toContain('apply_parallel')
    expect(rows.filter(r => r.key === 'p').map(r => r.command)).toEqual(['toggle_plane_visibility'])
  })

  it('every mode has a display label', () => {
    for (const r of rows) {
      expect(MODE_LABEL[r.mode].length).toBeGreaterThan(0)
    }
  })

  it('every row carries a label and a description', () => {
    for (const r of rows) {
      expect(r.label.length, `label missing for "${r.key}"`).toBeGreaterThan(0)
      expect(r.description.length, `description missing for "${r.key}"`).toBeGreaterThan(0)
    }
  })
})
