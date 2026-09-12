import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'
import type { PersistenceState } from '@/adapters/storagePersistence'

function wrap() {
  return render(
    <MemoryRouter initialEntries={['/documents/abc']}>
      <AppHeader title="Test" />
    </MemoryRouter>,
  )
}

// The dirty indicator is the second consumer of the persistence answer (the
// disclaimer is the first). Each state must read as a different fact about
// whether the browser will keep edits that are not saved yet.
describe('AppHeader dirty persistence copy', () => {
  beforeEach(() => {
    act(() => {
      useUnsavedChangesStore.getState().setDirty(true)
      useUnsavedChangesStore.getState().setSaveHandler(null)
    })
  })
  afterEach(() => {
    act(() => { useUnsavedChangesStore.getState().setDirty(false) })
    act(() => { useStoragePersistenceStore.setState({ state: 'unknown' }) })
  })

  const cases: { state: PersistenceState; copy: RegExp }[] = [
    { state: 'persisted', copy: /kept in this browser until you save/ },
    { state: 'best-effort', copy: /can be discarded by the browser/ },
    { state: 'unsupported', copy: /does not report whether its storage is persistent/ },
  ]

  for (const { state, copy } of cases) {
    it(`renders the ${state} sentence`, () => {
      act(() => { useStoragePersistenceStore.setState({ state }) })
      wrap()
      expect(screen.getByRole('status')).toHaveTextContent(copy)
    })
  }

  it('renders no durability claim before the browser has answered', () => {
    act(() => { useStoragePersistenceStore.setState({ state: 'unknown' }) })
    wrap()
    expect(screen.queryByText(/kept in this browser|can be discarded|does not report/)).toBeNull()
  })
})
