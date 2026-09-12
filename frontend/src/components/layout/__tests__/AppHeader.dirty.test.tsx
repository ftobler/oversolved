import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'
import { acquireModalEscape } from '@/utils/core/modalEscape'

function wrap() {
  return render(
    <MemoryRouter initialEntries={['/documents/abc']}>
      <AppHeader title="Test" />
    </MemoryRouter>,
  )
}

function markDirty(save: (() => boolean | Promise<boolean>) | null = null) {
  act(() => {
    useUnsavedChangesStore.getState().setDirty(true)
    useUnsavedChangesStore.getState().setSaveHandler(save)
  })
}

describe('AppHeader workspace dirty and explicit save', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().setSaveHandler(null)
    useUnsavedChangesStore.getState().dismissConfirm()
    useStoragePersistenceStore.setState({ state: 'unknown' })
  })
  afterEach(() => {
    act(() => {
      useUnsavedChangesStore.getState().setDirty(false)
      useUnsavedChangesStore.getState().setSaveHandler(null)
      useUnsavedChangesStore.getState().dismissConfirm()
    })
    useStoragePersistenceStore.setState({ state: 'unknown' })
    vi.restoreAllMocks()
  })

  it('renders nothing dirty-shaped when clean', () => {
    wrap()
    expect(screen.queryByLabelText('Save workspace')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the dirty indicator and a Save button when dirty', () => {
    markDirty()
    wrap()
    expect(screen.getByLabelText('Save workspace')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('the Save button invokes the handler and clears dirty', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.click(screen.getByLabelText('Save workspace')) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('Ctrl+S invokes the handler and clears dirty', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('Cmd+S invokes the handler too', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.keyDown(window, { key: 's', metaKey: true }) })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a failed save keeps dirty set', async () => {
    const save = vi.fn(async () => false)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('a text field owns Ctrl+S, so the workspace does not save', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    const { container } = wrap()
    const input = document.createElement('input')
    container.appendChild(input)

    await act(async () => { fireEvent.keyDown(input, { key: 's', ctrlKey: true }) })
    expect(save).not.toHaveBeenCalled()
  })

  it('an open dialog owns Ctrl+S, so the workspace does not save behind it', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()
    const release = acquireModalEscape()

    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    expect(save).not.toHaveBeenCalled()

    release()
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })
})
