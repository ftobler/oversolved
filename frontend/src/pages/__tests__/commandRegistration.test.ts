import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  registerCommand,
  unregisterCommand,
  executeCommand,
  KEYMAP,
  SHORTCUT_CONSTRAINT_KINDS,
} from '../../stores/commandRegistry'

// Commands that intentionally have no keyboard shortcut (programmatic-only).
// These are allowed to be absent from KEYMAP values.
const PROGRAMMATIC_ONLY_COMMANDS = new Set([
  'cancel_plane_selection',
  'set_tool_select',
  'set_tool_point',
  'set_tool_rect',
  'set_tool_center_rect',
])

// Mirrors the command config array that Part.tsx passes to useCommandRegistration.
// Handlers here are stubs — we only care about the structure.
function buildCommandConfig() {
  return [
    { name: 'undo',              fn: vi.fn() },
    { name: 'redo',              fn: vi.fn() },
    { name: 'delete_selected',   fn: vi.fn() },
    { name: 'set_tool_select',   fn: vi.fn() },
    { name: 'set_tool_line',     fn: vi.fn() },
    { name: 'set_tool_circle',   fn: vi.fn() },
    { name: 'set_tool_arc',      fn: vi.fn() },
    { name: 'set_tool_point',    fn: vi.fn() },
    { name: 'set_tool_rect',     fn: vi.fn() },
    { name: 'set_tool_center_rect', fn: vi.fn() },
    { name: 'set_tool_dimension',fn: vi.fn() },
    { name: 'toggle_construction', fn: vi.fn() },
    ...SHORTCUT_CONSTRAINT_KINDS.map(kind => ({ name: `apply_${kind}`, fn: vi.fn() })),
    { name: 'cancel_draw',           fn: vi.fn() },
    { name: 'cancel_plane_selection', fn: vi.fn() },
  ]
}

// ── Config array structure ────────────────────────────────────────────────────

describe('command config array structure', () => {
  const config = buildCommandConfig()

  it('every entry has a non-empty name string', () => {
    for (const entry of config) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
    }
  })

  it('no duplicate names', () => {
    const names = config.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every name appears in KEYMAP values or is a known programmatic-only command', () => {
    const keymapValues = new Set(Object.values(KEYMAP))
    for (const { name } of config) {
      const inKeymap = keymapValues.has(name)
      const isProgrammaticOnly = PROGRAMMATIC_ONLY_COMMANDS.has(name)
      expect(inKeymap || isProgrammaticOnly, `"${name}" is not in KEYMAP and not in PROGRAMMATIC_ONLY_COMMANDS`).toBe(true)
    }
  })

  it('every entry has a function handler', () => {
    for (const entry of config) {
      expect(typeof entry.fn).toBe('function')
    }
  })
})

// ── Registration lifecycle ────────────────────────────────────────────────────

describe('command registration lifecycle', () => {
  afterEach(() => {
    unregisterCommand('__lifecycle_a__')
    unregisterCommand('__lifecycle_b__')
  })

  it('register → execute → unregister: spies are called only while registered', () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    const commands = [
      { name: '__lifecycle_a__', fn: fnA },
      { name: '__lifecycle_b__', fn: fnB },
    ]

    // Register all
    for (const { name, fn } of commands) registerCommand(name, fn)

    // Execute — both spies must be called
    executeCommand('__lifecycle_a__')
    executeCommand('__lifecycle_b__')
    expect(fnA).toHaveBeenCalledOnce()
    expect(fnB).toHaveBeenCalledOnce()

    // Unregister all
    for (const { name } of commands) unregisterCommand(name)

    // Execute again — spies must NOT be called again
    executeCommand('__lifecycle_a__')
    executeCommand('__lifecycle_b__')
    expect(fnA).toHaveBeenCalledOnce()
    expect(fnB).toHaveBeenCalledOnce()
  })

  it('unregistering one command does not affect another', () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    registerCommand('__lifecycle_a__', fnA)
    registerCommand('__lifecycle_b__', fnB)

    unregisterCommand('__lifecycle_a__')

    executeCommand('__lifecycle_a__')
    executeCommand('__lifecycle_b__')

    expect(fnA).not.toHaveBeenCalled()
    expect(fnB).toHaveBeenCalledOnce()
  })
})
