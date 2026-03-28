import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  KEYMAP,
  registerCommand,
  unregisterCommand,
  executeCommand,
  buildKeyString,
  dispatchKey,
} from '../commandRegistry'
import { CONSTRAINT_SHORTCUTS } from '../../registry'

// Helper: build a minimal fake KeyboardEvent
function fakeKey(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
  target: Partial<HTMLElement> = {}
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent
}

// ── buildKeyString ───────────────────────────────────────────────────────────

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

// ── KEYMAP completeness ──────────────────────────────────────────────────────

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
  })

  it('contains constraint-registry-derived shortcuts', () => {
    for (const [key, cmd] of CONSTRAINT_SHORTCUTS) {
      expect(KEYMAP[key]).toBe(cmd)
    }
  })
})

// ── registerCommand / executeCommand / unregisterCommand ─────────────────────

describe('registerCommand / executeCommand / unregisterCommand', () => {
  afterEach(() => {
    unregisterCommand('__test__')
    unregisterCommand('__test_a__')
    unregisterCommand('__test_b__')
  })

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

// ── dispatchKey ──────────────────────────────────────────────────────────────

describe('dispatchKey', () => {
  afterEach(() => {
    unregisterCommand('__test__')
    unregisterCommand('undo')
  })

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

  it('does not call preventDefault for an unrecognised key', () => {
    const e = fakeKey('`')
    dispatchKey(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
