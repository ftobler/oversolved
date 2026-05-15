import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  KEYMAP,
  registerCommand,
  executeCommand,
  clearAllHandlers,
  dispatchKey,
} from '@/stores/commandRegistry'

beforeEach(() => { clearAllHandlers() })

function fakeKey(key: string, extra: Record<string, boolean> = {}): KeyboardEvent {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent
}

describe('keyboard command dispatch', () => {
  it('p key maps to apply_parallel in KEYMAP', () => {
    expect(KEYMAP['p']).toBe('apply_parallel')
  })

  it('y key maps to toggle_sketch_plane_visibility in KEYMAP', () => {
    expect(KEYMAP['y']).toBe('toggle_sketch_plane_visibility')
  })

  it('executeCommand dispatches undo', () => {
    const handler = vi.fn()
    registerCommand('undo', handler)
    executeCommand('undo')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('executeCommand dispatches redo', () => {
    const handler = vi.fn()
    registerCommand('redo', handler)
    executeCommand('redo')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ctrl+z dispatches undo', () => {
    const handler = vi.fn()
    registerCommand('undo', handler)
    dispatchKey(fakeKey('z', { ctrlKey: true }))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ctrl+shift+z dispatches redo', () => {
    const handler = vi.fn()
    registerCommand('redo', handler)
    dispatchKey(fakeKey('z', { ctrlKey: true, shiftKey: true }))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('p key dispatches apply_parallel via dispatchKey when registered', () => {
    const handler = vi.fn()
    registerCommand('apply_parallel', handler)
    dispatchKey(fakeKey('p'))
    expect(handler).toHaveBeenCalledOnce()
  })
})
