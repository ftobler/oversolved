// The journal restore offer: the two choices, the preview thumbnail, and the
// failure a rejected discard reports while keeping the question open.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RecoveryRestoreDialog from '@/components/dialogs/RecoveryRestoreDialog'
import type { RecoveryJournalRecord } from '@/recovery/journal'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

const record = (updatedAt = Date.now()): RecoveryJournalRecord => ({
  docId: 'doc-1',
  workspace: 'ws-1',
  updatedAt,
  docHash: 'hash',
  doc: makeDoc(makeSketch('sk1')),
  repro: null,
})

describe('RecoveryRestoreDialog', () => {
  it('restores on confirm and discards on the extra action', () => {
    const onRestore = vi.fn()
    const onDiscard = vi.fn()
    render(
      <RecoveryRestoreDialog
        offer={{ record: record(), thumbnail: null }}
        busy={false}
        onRestore={onRestore}
        onDiscard={onDiscard}
      />,
    )

    expect(screen.getByText('Restore unsaved changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore changes' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('shows the preview thumbnail when the journal has one', () => {
    render(
      <RecoveryRestoreDialog
        offer={{ record: record(), thumbnail: 'QUJD' }}
        busy={false}
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,QUJD')
  })

  it('keeps the question open and shows the reason when a discard failed', () => {
    render(
      <RecoveryRestoreDialog
        offer={{ record: record(), thumbnail: null }}
        busy={false}
        error="Could not discard the unsaved changes"
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByText('Could not discard the unsaved changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore changes' })).toBeEnabled()
  })

  it('seals both choices while a discard is in flight', () => {
    render(
      <RecoveryRestoreDialog
        offer={{ record: record(), thumbnail: null }}
        busy
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
  })
})
