import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  KEYMAP,
  SKETCH_KEYMAP,
  FEATURE_KEYMAP,
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
  it('p key maps to toggle_plane_visibility in KEYMAP', () => {
    expect(KEYMAP['p']).toBe('toggle_plane_visibility')
  })

  it('no key dispatches apply_parallel: it is toolbar-only', () => {
    const allMaps = [KEYMAP, SKETCH_KEYMAP, FEATURE_KEYMAP]
    for (const map of allMaps) {
      expect(Object.values(map)).not.toContain('apply_parallel')
    }
  })

  it('y key maps to toggle_sketch_plane_visibility in KEYMAP', () => {
    expect(KEYMAP['y']).toBe('toggle_sketch_plane_visibility')
  })

  it('executeCommand resolves undo to the undo handler and not redo', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    executeCommand('undo')
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).not.toHaveBeenCalled()
  })

  it('executeCommand resolves redo to the redo handler and not undo', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    executeCommand('redo')
    expect(redo).toHaveBeenCalledOnce()
    expect(undo).not.toHaveBeenCalled()
  })

  it('ctrl+z resolves to undo and marks the event handled', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    const event = fakeKey('z', { ctrlKey: true })
    expect(dispatchKey(event)).toBe(true)
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('ctrl+shift+z resolves to redo and marks the event handled', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    const event = fakeKey('z', { ctrlKey: true, shiftKey: true })
    expect(dispatchKey(event)).toBe(true)
    expect(redo).toHaveBeenCalledOnce()
    expect(undo).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('p key dispatches toggle_plane_visibility outside sketch mode', () => {
    const handler = vi.fn()
    registerCommand('toggle_plane_visibility', handler)
    dispatchKey(fakeKey('p'))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('SKETCH_KEYMAP holds no p override: the core binding already covers both modes', () => {
    expect(SKETCH_KEYMAP['p']).toBeUndefined()
  })

  it('p key dispatches toggle_plane_visibility in sketch mode', () => {
    useSketchEditorStore.getState().setActiveFeatureId('feat-1')
    const handler = vi.fn()
    registerCommand('toggle_plane_visibility', handler)
    dispatchKey(fakeKey('p'))
    expect(handler).toHaveBeenCalledOnce()
  })
})
