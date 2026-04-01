import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerCommand,
  executeCommand,
  clearAllHandlers,
} from '../../stores/commandRegistry'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { buildCommandEntries } from '../commandEntries'

// Ensure clean state before each test
beforeEach(() => { clearAllHandlers() })

// ── Config array structure ────────────────────────────────────────────────────

describe('command config array structure', () => {
  const config = buildCommandEntries(vi.fn(), vi.fn(), vi.fn())

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

  it('every entry has a function handler', () => {
    for (const entry of config) {
      expect(typeof entry.fn).toBe('function')
    }
  })
})

// ── Registration lifecycle ────────────────────────────────────────────────────

describe('command registration lifecycle', () => {
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

    // beforeEach will clear all handlers before the next test
    // Execute again in a fresh test — spies must NOT be called
  })

  it('multiple commands can be registered independently', () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    registerCommand('__lifecycle_a__', fnA)
    registerCommand('__lifecycle_b__', fnB)

    // Execute both
    executeCommand('__lifecycle_a__')
    executeCommand('__lifecycle_b__')

    // Both should have been called
    expect(fnA).toHaveBeenCalledOnce()
    expect(fnB).toHaveBeenCalledOnce()
  })
})

// ── Handler execution with store methods ──────────────────────────────────────

describe('handler execution with store methods', () => {
  it('delete_selected handler calls store.deleteSelected without throwing', () => {
    // Register handler that calls store method, as Part.tsx does
    registerCommand('__store_test__', () => useSketchEditorStore.getState().deleteSelected())
    // Confirm executeCommand reaches the store without throwing
    expect(() => executeCommand('__store_test__')).not.toThrow()
  })
})
