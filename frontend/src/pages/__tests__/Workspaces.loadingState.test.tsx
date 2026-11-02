import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { getWorkspaceStore, type WorkspaceSummary } from '@/workspace/store'
import { freshLocalDb } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

beforeEach(() => {
  freshLocalDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function wrap() {
  return render(
    <BrowserRouter>
      <Workspaces />
    </BrowserRouter>
  )
}

function summary(name: string, trashed: boolean): WorkspaceSummary {
  const now = Date.now()
  return {
    workspace: name.toLowerCase(),
    name,
    entryCount: 1,
    size: 0,
    createdAt: now,
    updatedAt: now,
    ...(trashed && { trashedAt: new Date(now).toISOString() }),
  }
}

describe('Workspaces loading state', () => {
  it('keeps the spinner visible while the list fetch is pending, and clears it only once it settles', async () => {
    // A controllable promise standing in for the store's list() call: it lets the
    // test observe the component mid-flight, before the fetch resolves.
    let resolveList: (docs: WorkspaceSummary[]) => void = () => {}
    const pending = new Promise<WorkspaceSummary[]>(resolve => { resolveList = resolve })
    vi.spyOn(getWorkspaceStore(), 'list').mockReturnValue(pending)

    wrap()

    // fetch is fire-and-forget: render() has already flushed the mount effect by
    // the time it returns, so this assertion is synchronous -- no waitFor.
    expect(screen.getByText('Loading workspaces...')).toBeInTheDocument()

    resolveList([])

    await waitForElementToBeRemoved(() => screen.queryByText('Loading workspaces...'))
    await waitFor(() => {
      expect(screen.getByText('No workspaces yet.')).toBeInTheDocument()
    })
  })

  // Every refresh is a fresh read of the store, and the trash toggle starts a
  // second read while the first may still be open. The later request is the one
  // the view is waiting for; an older answer must not replace it.
  it('drops a slower response from before the view changed', async () => {
    const gates: Array<{ resolve: (docs: WorkspaceSummary[]) => void }> = []
    vi.spyOn(getWorkspaceStore(), 'list').mockImplementation(() => new Promise<WorkspaceSummary[]>(resolve => {
      gates.push({ resolve })
    }))

    wrap()
    await waitFor(() => expect(gates).toHaveLength(1))

    fireEvent.click(screen.getByText('Trash'))
    await waitFor(() => expect(gates).toHaveLength(2))

    await act(async () => { gates[1].resolve([summary('Gone', true)]) })
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())

    // The first (library) read lands after the trash view already rendered.
    await act(async () => { gates[0].resolve([summary('Live', false)]) })
    expect(screen.getByText('Gone')).toBeInTheDocument()
    expect(screen.queryByText('Trash is empty.')).not.toBeInTheDocument()
  })
})
