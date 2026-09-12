import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react'
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
})
