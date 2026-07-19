import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function Host() {
  useUnsavedChangesGuard()
  return <div />
}

// jsdom does not run the browser's own unload prompt, so "the guard fired" is
// observed as the event having been cancelled (preventDefault / returnValue).
function fireBeforeUnload(): boolean {
  const e = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

describe('useUnsavedChangesGuard', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
  })

  it('does not block the unload when the document is clean', () => {
    render(<Host />)
    expect(fireBeforeUnload()).toBe(false)
  })

  it('blocks the unload while the document is dirty', () => {
    render(<Host />)
    useUnsavedChangesStore.getState().setDirty(true)
    expect(fireBeforeUnload()).toBe(true)
  })

  it('clears dirty on unmount so the flag cannot leak to another page', () => {
    const { unmount } = render(<Host />)
    useUnsavedChangesStore.getState().setDirty(true)
    unmount()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('stops guarding after unmount', () => {
    const { unmount } = render(<Host />)
    unmount()
    useUnsavedChangesStore.getState().setDirty(true)
    expect(fireBeforeUnload()).toBe(false)
  })
})
