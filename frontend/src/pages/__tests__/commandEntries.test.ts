import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildCommandEntries } from '@/pages/commandEntries'
import { KEYMAP, FEATURE_KEYMAP, SKETCH_KEYMAP, clearAllHandlers } from '@/stores/commandRegistry'

// Ensure clean state before each test
beforeEach(() => { clearAllHandlers() })

// Commands that intentionally have no keyboard shortcut.
const PROGRAMMATIC_ONLY = new Set([
  'cancel_pick',
  'set_tool_select',
  'set_tool_drag',
  'set_tool_point',
  'set_tool_rect',
  'set_tool_center_rect',
  'add_hole',
  'add_transform',
])

describe('buildCommandEntries', () => {
  const entries = buildCommandEntries(vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

  it('every entry has a non-empty name', () => {
    for (const e of entries) {
      expect(e.name.length).toBeGreaterThan(0)
    }
  })

  it('no duplicate names', () => {
    const names = entries.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every name is in KEYMAP/FEATURE_KEYMAP/SKETCH_KEYMAP values or is a known programmatic-only command', () => {
    const keymapValues = new Set([...Object.values(KEYMAP), ...Object.values(FEATURE_KEYMAP), ...Object.values(SKETCH_KEYMAP)])
    for (const { name } of entries) {
      const ok = keymapValues.has(name) || PROGRAMMATIC_ONLY.has(name)
      expect(ok, `"${name}" not in KEYMAP/FEATURE_KEYMAP and not in PROGRAMMATIC_ONLY`).toBe(true)
    }
  })

  it('every entry has a function handler', () => {
    for (const e of entries) {
      expect(typeof e.fn).toBe('function')
    }
  })

  it('handleUndo and handleRedo are wired to the undo and redo entries', () => {
    const handleUndo = vi.fn()
    const handleRedo = vi.fn()
    const entries = buildCommandEntries(handleUndo, handleRedo, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())
    entries.find(e => e.name === 'undo')!.fn()
    expect(handleUndo).toHaveBeenCalledOnce()
    entries.find(e => e.name === 'redo')!.fn()
    expect(handleRedo).toHaveBeenCalledOnce()
  })
})
