import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OriginsPanel } from '@/components/layout/OriginsPanel'
import { hashRecord } from '@/workspace/contentHash'
import type { OriginResolver } from '@/workspace/originResolver'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { documentEntry, treeWith } from '@/workspace/__tests__/fixtures'

// U6: every status is rendered, unreachable is neutral (no alert role), and the
// only control that reads an origin is the explicit one.

const CURRENT_TEXT = 'kind: part\n# current\n'
const CHANGED_TEXT = 'kind: part\n# changed\n'

const records: ProvenanceRecord[] = [
  { entry: 'e-current', origin: 'folder:current', originEntry: 'src-current', hash: hashRecord({ kind: 'document', text: CURRENT_TEXT }) },
  { entry: 'e-changed', origin: 'folder:changed', originEntry: 'src-changed', hash: hashRecord({ kind: 'document', text: 'kind: part\n# old\n' }) },
  { entry: 'e-unreachable', origin: 'folder:gone', originEntry: 'src-gone', hash: 'stale' },
]

const entries: EntryMeta[] = [
  { id: 'e-current', path: 'documents/Current.yaml', kind: 'document', name: 'Current', docKind: 'part', contentHash: records[0].hash },
  { id: 'e-changed', path: 'documents/Changed.yaml', kind: 'document', name: 'Changed', docKind: 'part', contentHash: records[1].hash },
  { id: 'e-unreachable', path: 'documents/Gone.yaml', kind: 'document', name: 'Gone', docKind: 'part', contentHash: records[2].hash },
]

function resolver(): OriginResolver {
  return {
    register: vi.fn(),
    resolve: async locator => {
      if (locator === 'folder:current') return treeWith([documentEntry('src-current', 'Current', { text: CURRENT_TEXT })])
      if (locator === 'folder:changed') return treeWith([documentEntry('src-changed', 'Changed', { text: CHANGED_TEXT })])
      return null
    },
  }
}

function installSession(custom: ProvenanceRecord[] = records, listed: EntryMeta[] = entries): WorkspaceSession {
  const session = {
    workspace: 'ws-1',
    provenance: async () => custom.map(record => ({ ...record })),
    listEntries: async () => listed,
  } as unknown as WorkspaceSession
  useWorkspaceSessionStore.setState({ session })
  return session
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
})

describe('OriginsPanel', () => {
  it('renders current, changed and unreachable, with unreachable neutral', async () => {
    installSession()
    render(<OriginsPanel resolver={resolver()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))

    await screen.findByText('Up to date')
    expect(screen.getByText('Origin changed')).toBeInTheDocument()
    expect(screen.getByText('Origin unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables update for a current origin but enables it for a changed one', async () => {
    installSession()
    render(<OriginsPanel resolver={resolver()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Up to date')

    expect(screen.getByRole('button', { name: 'Update Current' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update Changed' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Update Gone' })).toBeDisabled()
  })

  it('calls updateFromOrigin once per click on a changed row', async () => {
    const workspaceImport = await import('@/workspace/import')
    const update = vi.spyOn(workspaceImport, 'updateFromOrigin')
      .mockResolvedValue({ updated: 1, added: 0, unreachable: false, sourceMissing: false })
    installSession()
    const injected = resolver()
    render(<OriginsPanel resolver={injected} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Origin changed')
    await userEvent.click(screen.getByRole('button', { name: 'Update Changed' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith('ws-1', 'e-changed', injected)
    update.mockRestore()
  })

  it('does not resolve an origin on mount, only under the explicit check', async () => {
    installSession()
    const injected = resolver()
    const resolveSpy = vi.spyOn(injected, 'resolve')
    render(<OriginsPanel resolver={injected} />)

    // The records and local hashes load without a resolver read.
    await screen.findByText('Current')
    expect(resolveSpy).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(resolveSpy).toHaveBeenCalled())
  })

  it('marks a record with no source entry id not updatable without resolving it', async () => {
    const loose: ProvenanceRecord = { entry: 'e-loose', origin: 'file:loose', hash: 'abc' }
    const looseEntry: EntryMeta = {
      id: 'e-loose', path: 'documents/Loose.yaml', kind: 'document', name: 'Loose', docKind: 'part', contentHash: 'abc',
    }
    installSession([loose], [looseEntry])
    const injected = resolver()
    const resolveSpy = vi.spyOn(injected, 'resolve')
    render(<OriginsPanel resolver={injected} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Not updatable')
    expect(screen.getByRole('button', { name: 'Update Loose' })).toBeDisabled()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('surfaces a sourceMissing update instead of swallowing it', async () => {
    const workspaceImport = await import('@/workspace/import')
    const update = vi.spyOn(workspaceImport, 'updateFromOrigin')
      .mockResolvedValue({ updated: 0, added: 0, unreachable: false, sourceMissing: true })
    installSession()
    render(<OriginsPanel resolver={resolver()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Origin changed')
    await userEvent.click(screen.getByRole('button', { name: 'Update Changed' }))

    expect(await screen.findByText(/source entry is gone/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    update.mockRestore()
  })

  it('enables update for a locally edited copy whose source is unchanged', async () => {
    const sourceText = 'kind: part\n# source\n'
    const localText = 'kind: part\n# local edit\n'
    const edited: ProvenanceRecord = {
      entry: 'e-edited', origin: 'folder:edited', originEntry: 'src-edited',
      hash: hashRecord({ kind: 'document', text: sourceText }),
    }
    const editedEntry: EntryMeta = {
      id: 'e-edited', path: 'documents/Edited.yaml', kind: 'document', name: 'Edited',
      docKind: 'part', contentHash: hashRecord({ kind: 'document', text: localText }),
    }
    const injected: OriginResolver = {
      register: vi.fn(),
      resolve: async locator => locator === 'folder:edited'
        ? treeWith([documentEntry('src-edited', 'Edited', { text: sourceText })])
        : null,
    }
    installSession([edited], [editedEntry])
    render(<OriginsPanel resolver={injected} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Up to date')
    expect(screen.getByText('edited locally')).toBeInTheDocument()
    const update = screen.getByRole('button', { name: 'Update Edited' })
    expect(update).toBeEnabled()
    expect(update).toHaveAttribute('title', 'Updating overwrites your local edits.')
  })
})
