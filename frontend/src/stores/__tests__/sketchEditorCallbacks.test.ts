// The callback registry's canonical teardown. The editor unmount and both
// test setups used to hand-list the slots to null, which drifted twice (the
// matrix harness missed checkRedundantAdd/showMessage). clearSketchCallbacks
// owns the list; this suite makes a new port impossible to forget.
import { describe, it, expect, afterEach } from 'vitest'
import {
  clearSketchCallbacks,
  getSketchCallback,
  setSketchCallback,
  useSketchUiStore,
} from '@/stores/sketchEditorStore'
import { sketchCallbacks } from '@/stores/sketchEditorCallbacks'
import type { DialogState } from '@/stores/sketchEditorTypes'

// Store plumbing registered by sketchEditorStore at module scope, not editor
// session state: the dialog must keep working after an editor teardown.
const STORE_PORTS = new Set(['openDialog', 'closeDialog'])

afterEach(() => {
  clearSketchCallbacks()
  useSketchUiStore.getState().resetTransientState()
})

describe('clearSketchCallbacks', () => {
  it('nulls every session port, including the two the hand lists had missed', () => {
    setSketchCallback('onMutation', () => undefined)
    setSketchCallback('checkRedundantAdd', () => true)
    setSketchCallback('showMessage', () => undefined)

    clearSketchCallbacks()

    expect(getSketchCallback('onMutation')).toBeNull()
    expect(getSketchCallback('checkRedundantAdd')).toBeNull()
    expect(getSketchCallback('showMessage')).toBeNull()
  })

  it('clears every non-store port the registry declares', () => {
    // Sentinel every slot, then require the teardown to cover each one. A new
    // callback slot must be added to SESSION_CALLBACK_KEYS with it, or this
    // fails on the leaked sentinel.
    const sentinel = (): never => {
      throw new Error('sentinel')
    }
    for (const key of Object.keys(sketchCallbacks) as (keyof typeof sketchCallbacks)[]) {
      if (!STORE_PORTS.has(key)) (setSketchCallback as (slot: keyof typeof sketchCallbacks, cb: unknown) => void)(key, sentinel)
    }
    clearSketchCallbacks()
    const leaked = (Object.keys(sketchCallbacks) as (keyof typeof sketchCallbacks)[])
      .filter(key => !STORE_PORTS.has(key) && sketchCallbacks[key] !== null)
    expect(leaked).toEqual([])
  })

  it('leaves the dialog ports live so an editor teardown cannot break the value dialog', () => {
    clearSketchCallbacks()
    const dialog = { position: [0, 0], label: 'Distance', onConfirm: () => undefined } as DialogState
    expect(() => useSketchUiStore.getState().openDialog(dialog)).not.toThrow()
    expect(useSketchUiStore.getState().pendingDialog).toEqual(dialog)
  })
})
