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

const saveButtons = () => screen.queryAllByRole('button', { name: /save/i })

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

  // The editors' toolbar Save is the only Save and carries the dirty tint. The
  // header adds neither: off an editor no save handler exists, so a header
  // button could only ever be a dead, disabled one, and the dot beside it is
  // gone. Checked with and without a registered handler.
  it.each([
    ['clean, no handler', false, null],
    ['dirty, no handler', true, null],
    ['dirty, handler registered', true, async () => true],
  ] as const)('renders no Save and no dirty mark when %s', (_label, dirty, save) => {
    act(() => {
      useUnsavedChangesStore.getState().setDirty(dirty)
      useUnsavedChangesStore.getState().setSaveHandler(save)
    })
    const { container } = wrap()
    expect(saveButtons()).toHaveLength(0)
    expect(container.querySelector('[data-dirty]')).toBeNull()
    expect(container.querySelector('.header-dirty-dot')).toBeNull()
    expect(container.querySelector('.workspace-dirty')).toBeNull()
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

  // The handler alone knows whether an edit landed while its bytes were in
  // flight, so a `true` is not "clean": the header leaves dirty to it. This
  // handler reports success without clearing, as saveDoc does after a mid-save
  // edit.
  it('Ctrl+S invokes the handler and leaves dirty to it', async () => {
    const save = vi.fn(async () => true)
    markDirty(save)
    wrap()

    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
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
