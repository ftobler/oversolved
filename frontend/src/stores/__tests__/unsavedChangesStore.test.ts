import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useUnsavedChangesStore, confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'

describe('confirmDiscardUnsavedChanges', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('proceeds without prompting when there are no unsaved changes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(confirmDiscardUnsavedChanges()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('blocks and keeps the dirty flag when the user cancels the prompt', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(confirmDiscardUnsavedChanges()).toBe(false)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('proceeds and clears the dirty flag when the user confirms discard', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(confirmDiscardUnsavedChanges()).toBe(true)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})
