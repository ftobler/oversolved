import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  KEYMAP,
  FEATURE_KEYMAP,
  CORE_KEYBINDINGS,
  registerCommand,
  unregisterCommand,
  executeCommand,
  clearAllHandlers,
  buildKeyString,
  dispatchKey,
  isEditableTarget,
} from '@/utils/core/commandRegistry'
import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'

// Ensure clean state before each test
beforeEach(() => { clearAllHandlers() })

// Helper: build a minimal fake KeyboardEvent
function fakeKey(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing'>> = {},
  target: Partial<HTMLElement> = {}
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...modifiers,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent
}

// Ensure clean state before each test
beforeEach(() => { clearAllHandlers() })

// ─── buildKeyString ───

describe('buildKeyString', () => {
  it('plain key with no modifiers', () => {
    expect(buildKeyString(fakeKey('a'))).toBe('a')
  })

  it('ctrl modifier', () => {
    expect(buildKeyString(fakeKey('z', { ctrlKey: true }))).toBe('ctrl+z')
  })

  it('ctrl+shift modifier', () => {
    expect(buildKeyString(fakeKey('z', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+z')
  })

  it('meta is treated the same as ctrl', () => {
    expect(buildKeyString(fakeKey('z', { metaKey: true }))).toBe('ctrl+z')
  })

  it('key is lowercased', () => {
    expect(buildKeyString(fakeKey('Delete'))).toBe('delete')
  })

  it('alt modifier', () => {
    expect(buildKeyString(fakeKey('f', { altKey: true }))).toBe('alt+f')
  })
})

// ─── KEYMAP completeness ───

describe('KEYMAP', () => {
  it('every value is a non-empty command name string', () => {
    for (const [, cmd] of Object.entries(KEYMAP)) {
      expect(typeof cmd).toBe('string')
      expect(cmd.length).toBeGreaterThan(0)
    }
  })

  it('every key matches buildKeyString format: lowercase with + separators', () => {
    const keyPattern = /^[a-z0-9+]+$/
    for (const key of Object.keys(KEYMAP)) {
      expect(key).toMatch(keyPattern)
    }
  })

  it('no duplicate keys', () => {
    const keys = Object.keys(KEYMAP)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('contains core keybindings', () => {
    expect(KEYMAP['ctrl+z']).toBe('undo')
    expect(KEYMAP['ctrl+shift+z']).toBe('redo')
    expect(KEYMAP['ctrl+y']).toBe('redo')
    expect(KEYMAP['delete']).toBe('delete_selected')
    expect(KEYMAP['backspace']).toBe('delete_selected')
    expect(KEYMAP['escape']).toBe('cancel_draw')
    expect(KEYMAP['d']).toBe('set_tool_dimension')
    expect(KEYMAP['q']).toBe('toggle_construction')
  })

  it('contains constraint-registry-derived shortcuts', () => {
    for (const [key, cmd] of CONSTRAINT_SHORTCUTS) {
      expect(KEYMAP[key]).toBe(cmd)
    }
  })

  it('contains entity-registry-derived shortcuts', () => {
    for (const [key, cmd] of ENTITY_SHORTCUTS) {
      expect(KEYMAP[key]).toBe(cmd)
    }
  })
})

// ─── CORE_KEYBINDINGS ───

describe('CORE_KEYBINDINGS', () => {
  it('every entry has a non-empty label string', () => {
    for (const b of CORE_KEYBINDINGS) {
      expect(typeof b.label).toBe('string')
      expect(b.label.length, `label missing for key "${b.key}"`).toBeGreaterThan(0)
    }
  })

  it('every entry has a non-empty description string', () => {
    for (const b of CORE_KEYBINDINGS) {
      expect(typeof b.description).toBe('string')
      expect(b.description.length, `description missing for key "${b.key}"`).toBeGreaterThan(0)
    }
  })

  it('every entry has a non-empty key and command string', () => {
    for (const b of CORE_KEYBINDINGS) {
      expect(b.key.length).toBeGreaterThan(0)
      expect(b.command.length).toBeGreaterThan(0)
    }
  })

  it('KEYMAP or FEATURE_KEYMAP contains all CORE_KEYBINDINGS entries with correct command mapping', () => {
    for (const { key, command } of CORE_KEYBINDINGS) {
      const resolved = FEATURE_KEYMAP[key] ?? KEYMAP[key]
      expect(resolved, `KEYMAP/FEATURE_KEYMAP["${key}"] should be "${command}"`).toBe(command)
    }
  })

  it('contains expected core bindings', () => {
    const byKey = Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b]))
    expect(byKey['ctrl+z'].command).toBe('undo')
    expect(byKey['ctrl+shift+z'].command).toBe('redo')
    expect(byKey['ctrl+y'].command).toBe('redo')
    expect(byKey['delete'].command).toBe('delete_selected')
    expect(byKey['backspace'].command).toBe('delete_selected')
    expect(byKey['escape'].command).toBe('cancel_draw')
    expect(byKey['d'].command).toBe('set_tool_dimension')
    expect(byKey['q'].command).toBe('toggle_construction')
  })
})

// ─── isEditableTarget ───

describe('isEditableTarget', () => {
  it('returns true for INPUT', () => {
    expect(isEditableTarget(fakeKey('a', {}, { tagName: 'INPUT' }))).toBe(true)
  })

  it('returns true for TEXTAREA', () => {
    expect(isEditableTarget(fakeKey('a', {}, { tagName: 'TEXTAREA' }))).toBe(true)
  })

  it('returns true for SELECT', () => {
    expect(isEditableTarget(fakeKey('a', {}, { tagName: 'SELECT' }))).toBe(true)
  })

  it('returns false for a plain DIV', () => {
    expect(isEditableTarget(fakeKey('a', {}, { tagName: 'DIV' }))).toBe(false)
  })

  it('returns true during IME composition', () => {
    expect(isEditableTarget(fakeKey('a', { isComposing: true }))).toBe(true)
  })

  it('returns true when the key is Unidentified', () => {
    expect(isEditableTarget(fakeKey('Unidentified'))).toBe(true)
  })
})

// ─── registerCommand / executeCommand / unregisterCommand ───

describe('registerCommand / executeCommand / unregisterCommand', () => {
  it('registered handler is called by executeCommand', () => {
    const fn = vi.fn()
    registerCommand('__test__', fn)
    executeCommand('__test__')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('executeCommand for unknown name does not throw', () => {
    expect(() => executeCommand('__nonexistent__')).not.toThrow()
  })

  it('after unregisterCommand the handler is not called', () => {
    const fn = vi.fn()
    registerCommand('__test__', fn)
    unregisterCommand('__test__')
    executeCommand('__test__')
    expect(fn).not.toHaveBeenCalled()
  })

  it('registering the same name twice replaces the handler (last write wins)', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    registerCommand('__test__', fn1)
    registerCommand('__test__', fn2)
    executeCommand('__test__')
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('multiple independent commands do not interfere', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    registerCommand('__test_a__', fn1)
    registerCommand('__test_b__', fn2)
    executeCommand('__test_a__')
    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).not.toHaveBeenCalled()
  })
})

// ─── dispatchKey ───

describe('dispatchKey', () => {
  it('returns false and does not call handler when target is INPUT', () => {
    const fn = vi.fn()
    registerCommand('__test__', fn)
    const e = fakeKey('a', {}, { tagName: 'INPUT' })
    expect(dispatchKey(e)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns false and does not call handler when target is TEXTAREA', () => {
    const fn = vi.fn()
    registerCommand('__test__', fn)
    const e = fakeKey('a', {}, { tagName: 'TEXTAREA' })
    expect(dispatchKey(e)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns false and does not invoke undo handler when target is SELECT with ctrl+z', () => {
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true }, { tagName: 'SELECT' })
    expect(dispatchKey(e)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('returns false and does not invoke tool/constraint commands when target is SELECT', () => {
    const togglePlane = vi.fn()
    const addExtrude = vi.fn()
    const applyHorizontal = vi.fn()
    registerCommand('toggle_plane_visibility', togglePlane)
    registerCommand('add_extrude', addExtrude)
    registerCommand('apply_horizontal', applyHorizontal)
    for (const key of ['p', 'e', 'h']) {
      const e = fakeKey(key, {}, { tagName: 'SELECT' })
      expect(dispatchKey(e)).toBe(false)
    }
    expect(togglePlane).not.toHaveBeenCalled()
    expect(addExtrude).not.toHaveBeenCalled()
    expect(applyHorizontal).not.toHaveBeenCalled()
  })

  it('dispatches ctrl+z when target is a plain DIV', () => {
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true }, { tagName: 'DIV' })
    expect(dispatchKey(e)).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does not dispatch when a keydown is composing on a DIV', () => {
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true, isComposing: true }, { tagName: 'DIV' })
    expect(dispatchKey(e)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns false for a key not in KEYMAP', () => {
    const e = fakeKey('`')
    expect(dispatchKey(e)).toBe(false)
  })

  it('returns true and calls the registered handler for a key in KEYMAP', () => {
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true })
    expect(dispatchKey(e)).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('calls preventDefault on a matched key', () => {
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true })
    dispatchKey(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('does not throw when mapped command has no registered handler', () => {
    // 'undo' is in KEYMAP but we deliberately do not register a handler
    const e = fakeKey('z', { ctrlKey: true })
    expect(() => dispatchKey(e)).not.toThrow()
  })

  // A keymap entry with no handler is a registration gap (a bug): the keystroke
  // must pass through to the browser instead of being swallowed without signal.
  it('returns false, does not preventDefault and warns for a mapped command with no handler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = fakeKey('z', { ctrlKey: true })
    expect(dispatchKey(e)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('undo')
    warnSpy.mockRestore()
  })

  it('dispatches normally once the handler registers: no warning, handler ran', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fn = vi.fn()
    registerCommand('undo', fn)
    const e = fakeKey('z', { ctrlKey: true })
    expect(dispatchKey(e)).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not call preventDefault for an unrecognised key', () => {
    const e = fakeKey('`')
    dispatchKey(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})

// ─── Tool commands via store (no React) ───

describe('tool commands via store', () => {
  // The store drives each tool's activate/deactivate hooks, and those maintain
  // the mode stack. Without the registry the hooks are silent no-ops and the
  // store's own invariants (armed tool owns the stack top) cannot hold.
  beforeAll(() => { initializeTools() })

  beforeEach(() => {
    // Reset to known state before each test
    useSketchEditorStore.getState().setActiveTool(null)
  })

  it('set_tool_line activates the line tool', () => {
    registerCommand('set_tool_line', () => useSketchEditorStore.getState().setActiveTool('line'))
    executeCommand('set_tool_line')
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
  })

  it('set_tool_circle activates the circle tool', () => {
    registerCommand('set_tool_circle', () => useSketchEditorStore.getState().setActiveTool('circle'))
    executeCommand('set_tool_circle')
    expect(useSketchEditorStore.getState().activeTool).toBe('circle')
  })

  it('set_tool_arc activates the arc tool', () => {
    registerCommand('set_tool_arc', () => useSketchEditorStore.getState().setActiveTool('arc'))
    executeCommand('set_tool_arc')
    expect(useSketchEditorStore.getState().activeTool).toBe('arc')
  })

  it('set_tool_point activates the point tool', () => {
    registerCommand('set_tool_point', () => useSketchEditorStore.getState().setActiveTool('point'))
    executeCommand('set_tool_point')
    expect(useSketchEditorStore.getState().activeTool).toBe('point')
  })

  it('set_tool_rect activates the rectangle tool', () => {
    registerCommand('set_tool_rect', () => useSketchEditorStore.getState().setActiveTool('rect'))
    executeCommand('set_tool_rect')
    expect(useSketchEditorStore.getState().activeTool).toBe('rect')
  })

  it('set_tool_center_rect activates the center-rectangle tool', () => {
    registerCommand('set_tool_center_rect', () => useSketchEditorStore.getState().setActiveTool('center_rect'))
    executeCommand('set_tool_center_rect')
    expect(useSketchEditorStore.getState().activeTool).toBe('center_rect')
  })

  it('set_tool_dimension activates the dimension tool', () => {
    registerCommand('set_tool_dimension', () => useSketchEditorStore.getState().setActiveTool('dimension'))
    executeCommand('set_tool_dimension')
    expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
  })

  it('toggle_construction calls toggleConstruction on the store', () => {
    registerCommand('toggle_construction', () => useSketchEditorStore.getState().toggleConstruction())
    // Should not throw with no selection
    expect(() => executeCommand('toggle_construction')).not.toThrow()
  })

  it('apply_horizontal calls applyConstraint on the store without throwing', () => {
    registerCommand('apply_horizontal', () => useSketchEditorStore.getState().applyConstraint('horizontal'))
    expect(() => executeCommand('apply_horizontal')).not.toThrow()
  })

  it('apply_parallel calls applyConstraint on the store without throwing', () => {
    registerCommand('apply_parallel', () => useSketchEditorStore.getState().applyConstraint('parallel'))
    expect(() => executeCommand('apply_parallel')).not.toThrow()
  })

  it('constraint shortcuts take precedence over core keybindings with same key', () => {
    // 'e' is in CORE_KEYBINDINGS for add_extrude and in CONSTRAINT_SHORTCUTS for
    // apply_equal_length: the constraint wins in the merged KEYMAP, and
    // FEATURE_KEYMAP restores add_extrude outside sketch-edit mode.
    expect(KEYMAP['e']).toBe('apply_equal_length')
    expect(FEATURE_KEYMAP['e']).toBe('add_extrude')
    expect(KEYMAP['y']).toBe('toggle_sketch_plane_visibility')
  })

  it('parallel has no shortcut, so no key resolves to apply_parallel', () => {
    // The 'p' mnemonic belongs to plane visibility; advertising it for parallel
    // put an unreachable key in the tooltip and the Registry page.
    expect(CONSTRAINT_SHORTCUTS.has('p')).toBe(false)
    expect(KEYMAP['p']).toBe('toggle_plane_visibility')
    expect(Object.values(KEYMAP)).not.toContain('apply_parallel')
  })

  it('p resolves to toggle_plane_visibility both inside and outside sketch edit', () => {
    const fn = vi.fn()
    registerCommand('toggle_plane_visibility', fn)

    useSketchEditorStore.getState().setActiveFeatureId(null)
    dispatchKey(fakeKey('p'))
    useSketchEditorStore.getState().setActiveFeatureId('feat-1')
    dispatchKey(fakeKey('p'))
    useSketchEditorStore.getState().setActiveFeatureId(null)

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('entity shortcut keys in KEYMAP map to set_tool_* commands', () => {
    // Verify the merged KEYMAP contains entity shortcuts
    expect(KEYMAP['l']).toBe('set_tool_line')
    expect(KEYMAP['o']).toBe('set_tool_circle')
    expect(KEYMAP['a']).toBe('set_tool_arc')
  })

  it('dispatchKey for entity shortcut activates the tool via store', () => {
    registerCommand('set_tool_line', () => useSketchEditorStore.getState().setActiveTool('line'))
    const e = fakeKey('l')
    dispatchKey(e)
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
  })
})

// ─── registerCommand collision warning ───

describe('registerCommand collision warning', () => {
  it('warns in dev mode when overwriting an existing handler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerCommand('__collision__', vi.fn())
    registerCommand('__collision__', vi.fn())
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('__collision__')
    warnSpy.mockRestore()
  })

  it('does not warn when registering a new (non-duplicate) handler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerCommand('__unique_a__', vi.fn())
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// dispatchKey has already preventDefaulted by the time executeCommand runs, so
// an unregistered command silently eats the keystroke. Dev mode must say so.
describe('executeCommand unknown-command warning', () => {
  it('warns in dev mode when no handler is registered for the command', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    executeCommand('__nonexistent__')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('__nonexistent__')
    warnSpy.mockRestore()
  })

  it('does not warn when a handler is registered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerCommand('__known__', vi.fn())
    executeCommand('__known__')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ─── clearAllHandlers ───

describe('clearAllHandlers', () => {
  it('removes all registered handlers', () => {
    registerCommand('__clear_test__', vi.fn())
    clearAllHandlers()
    // After clearing, executeCommand must not throw and must do nothing
    expect(() => executeCommand('__clear_test__')).not.toThrow()
    // Registering again after clear must work
    const fn = vi.fn()
    registerCommand('__clear_test__', fn)
    executeCommand('__clear_test__')
    expect(fn).toHaveBeenCalledOnce()
    unregisterCommand('__clear_test__')
  })
})
