import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  KEYMAP,
  SKETCH_KEYMAP,
  registerCommand,
  executeCommand,
  clearAllHandlers,
  dispatchKey,
} from '@/utils/core/commandRegistry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

beforeEach(() => { clearAllHandlers() })
afterEach(() => { useSketchEditorStore.getState().setActiveFeatureId(null) })

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

  it('p key dispatches toggle_plane_visibility outside sketch mode', () => {
    const handler = vi.fn()
    registerCommand('toggle_plane_visibility', handler)
    dispatchKey(fakeKey('p'))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('p key maps to toggle_plane_visibility in SKETCH_KEYMAP', () => {
    expect(SKETCH_KEYMAP['p']).toBe('toggle_plane_visibility')
  })

  it('p key dispatches toggle_plane_visibility in sketch mode', () => {
    useSketchEditorStore.getState().setActiveFeatureId('feat-1')
    const handler = vi.fn()
    registerCommand('toggle_plane_visibility', handler)
    dispatchKey(fakeKey('p'))
    expect(handler).toHaveBeenCalledOnce()
  })
})
