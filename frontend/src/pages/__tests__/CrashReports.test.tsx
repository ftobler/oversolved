// The crash reports page: lists what the error paths recorded, exports one as
// a zip (the download helper is mocked; the zip contents are covered by the
// crashReports suite), and deletes.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import CrashReports from '@/pages/CrashReports'
import { recordCrashReport } from '@/recovery/crashReports'
import { resetDbConnection } from '@/stores/documentStore/idb'

vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: vi.fn() }))

import { downloadBlob } from '@/utils/core/downloadBlob'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  vi.clearAllMocks()
})

describe('CrashReports page', () => {
  it('shows the empty state when nothing was recorded', async () => {
    render(<CrashReports />)
    expect(await screen.findByText(/No crash reports/)).toBeInTheDocument()
  })

  it('lists a recorded crash with its source, doc and edit count', async () => {
    await recordCrashReport({
      source: 'worker',
      message: 'solver worker crashed',
      snapshot: null,
      at: Date.now() - 60_000,
    })

    render(<CrashReports />)
    expect(await screen.findByText('solver worker crashed')).toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.getByText(/no recorded edits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download zip' })).toBeEnabled()
  })

  it('downloads a report under a name carrying its source', async () => {
    await recordCrashReport({ source: 'boundary', message: 'editor fell over', snapshot: null })

    render(<CrashReports />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download zip' }))

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const [, filename] = vi.mocked(downloadBlob).mock.calls[0]
    expect(filename).toMatch(/^oversolved-crash-\d{8}-\d{4}-boundary\.zip$/)
  })

  it('deletes a report and falls back to the empty state', async () => {
    await recordCrashReport({ source: 'error', message: 'delete me', snapshot: null })

    render(<CrashReports />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(await screen.findByText(/No crash reports/)).toBeInTheDocument()
  })
})
