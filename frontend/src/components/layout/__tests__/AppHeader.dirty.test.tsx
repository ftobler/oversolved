import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'
import { acquireModalEscape } from '@/utils/core/modalEscape'

function wrap(ownsSave = false) {
  return render(
    <MemoryRouter initialEntries={['/documents/abc']}>
      <AppHeader title="Test" ownsSave={ownsSave} />
    </MemoryRouter>,
  )
}

const saveButtons = () => screen.queryAllByRole('button', { name: 'Save' })

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
    const { container } = wrap()
    expect(saveButtons()).toHaveLength(0)
    expect(container.querySelector('[data-dirty]')).toBeNull()
  })

  // Outside an editor (the workspace view an editor unmounted into) the header
  // is the only place the unsaved state can show. The tinted button is the
  // whole indicator: the dot that used to sit beside it is gone.
  it('shows one tinted Save button and no dot when dirty', () => {
    markDirty()
    const { container } = wrap()
    expect(saveButtons()).toHaveLength(1)
    const button = saveButtons()[0]
    expect(button.classList.contains('dirty')).toBe(true)
    expect(button.getAttribute('data-dirty')).toBe('true')
    expect(button.getAttribute('title')).toBe('Save (unsaved changes)')
    expect(container.querySelector('.header-dirty-dot')).toBeNull()
    expect(container.querySelector('.workspace-dirty')).toBeNull()
  })

  it('adds no Save button of its own where the toolbar has one', () => {
    markDirty(vi.fn(async () => true))
    const { container } = wrap(true)
    expect(saveButtons()).toHaveLength(0)
    expect(container.querySelector('[data-dirty]')).toBeNull()
  })

  it('the header Save is disabled when no editor registered a save', () => {
    markDirty()
    wrap()
    expect(saveButtons()[0]).toBeDisabled()
  })

  // The indicator is a state, not an announcement. It was a live region
  // carrying a sentence about eviction under disk pressure -- a claim that was
  // false either way it was read, and one no screen reader should be
  // interrupted for. Every persistence answer is checked, because the sentence
  // had one per state and re-adding any of them should fail here.
  it.each(['unknown', 'persisted', 'best-effort', 'unsupported'] as const)(
    'says nothing about durability under %s, and announces nothing',
    (state) => {
      act(() => { useStoragePersistenceStore.setState({ state }) })
      markDirty()
      wrap()
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByText(/kept in this browser|can be discarded|does not report/)).toBeNull()
    },
  )

  it('the Save button invokes the handler and clears dirty', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.click(saveButtons()[0]) })
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
