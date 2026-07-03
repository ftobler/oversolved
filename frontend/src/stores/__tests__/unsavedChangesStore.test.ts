import { describe, it, expect, beforeEach } from 'vitest'
import { useUnsavedChangesStore, confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'

describe('confirmDiscardUnsavedChanges', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
  })

  it('proceeds without prompting when there are no unsaved changes', () => {
    expect(confirmDiscardUnsavedChanges()).toBe(true)
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  it('returns false and stores a callback when the document is dirty', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    expect(confirmDiscardUnsavedChanges()).toBe(false)
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('executing the pending callback clears dirty and fires onProceed', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    let proceeded = false
    expect(confirmDiscardUnsavedChanges(() => { proceeded = true })).toBe(false)
    const cb = useUnsavedChangesStore.getState().pendingCallback
    expect(cb).not.toBeNull()
    cb!()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(proceeded).toBe(true)
  })

  it('dismissConfirm clears the pending callback', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    confirmDiscardUnsavedChanges()
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    useUnsavedChangesStore.getState().dismissConfirm()
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })
})
