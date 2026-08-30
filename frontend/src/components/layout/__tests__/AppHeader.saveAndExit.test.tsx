import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function wrap(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader title="Test" />
    </MemoryRouter>,
  )
}

describe('AppHeader unsaved-changes Save & Exit', () => {
  beforeEach(() => {
    const store = useUnsavedChangesStore.getState()
    store.setDirty(false)
    store.dismissConfirm()
    store.setSaveHandler(null)
  })
  afterEach(() => {
    act(() => {
      useUnsavedChangesStore.getState().dismissConfirm()
      useUnsavedChangesStore.getState().setSaveHandler(null)
      useUnsavedChangesStore.getState().setDirty(false)
    })
  })

  function openDialog() {
    const proceed = vi.fn()
    act(() => { useUnsavedChangesStore.getState().requestConfirm(proceed) })
    return proceed
  }

  it('offers only Discard when no editor registered a save', () => {
    wrap('/documents/abc')
    openDialog()
    expect(screen.getByText('Discard')).toBeTruthy()
    expect(screen.queryByText('Save & Exit')).toBeNull()
  })

  it('saves and then proceeds', async () => {
    const save = vi.fn(async () => true)
    act(() => { useUnsavedChangesStore.getState().setSaveHandler(save) })
    wrap('/documents/abc')
    const proceed = openDialog()

    await act(async () => { fireEvent.click(screen.getByText('Save & Exit')) })
    expect(save).toHaveBeenCalled()
    expect(proceed).toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  it('holds the dialog open when the save fails', async () => {
    const save = vi.fn(async () => false)
    act(() => { useUnsavedChangesStore.getState().setSaveHandler(save) })
    wrap('/documents/abc')
    const proceed = openDialog()

    await act(async () => { fireEvent.click(screen.getByText('Save & Exit')) })
    expect(save).toHaveBeenCalled()
    // Leaving anyway would drop the very edits the save was meant to keep.
    expect(proceed).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
  })

  it('keeps Discard reachable beside Save & Exit', async () => {
    act(() => { useUnsavedChangesStore.getState().setSaveHandler(vi.fn(async () => true)) })
    wrap('/documents/abc')
    const proceed = openDialog()

    await act(async () => { fireEvent.click(screen.getByText('Discard')) })
    expect(proceed).toHaveBeenCalled()
  })
})
