import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { freshLocalDb, seedStore } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

// The create dialog carries the kind on the entry now, not in the body: a
// workspace is the unit, and its cover entry's `docKind` is what the editor
// route interprets. An assembly is still a create of its own kind, so the part
// default is not written behind it.

beforeEach(() => {
  freshLocalDb()
})

afterEach(() => {
  // no timers are faked here; the create dialog has none
})

function wrap() {
  return render(
    <BrowserRouter>
      <Workspaces />
    </BrowserRouter>
  )
}

async function openAddDialog() {
  wrap()
  await waitFor(() => expect(screen.getByText('Workspaces', { selector: '.sidebar-item-label' })).toBeInTheDocument())
  await act(async () => {
    fireEvent.click(screen.getByTitle('New part workspace'))
  })
  await waitFor(() => expect(screen.getByPlaceholderText('Part name')).toBeInTheDocument())
}

describe('Workspaces create dialog', () => {
  it('shows the empty-name message when submitting a blank name', async () => {
    await openAddDialog()

    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    expect(screen.getByText('Workspace name cannot be empty')).toBeInTheDocument()
  })

  it('clears the message once a non-empty name is typed', async () => {
    await openAddDialog()
    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })
    expect(screen.getByText('Workspace name cannot be empty')).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Part name'), { target: { value: 'bracket' } })
    })

    expect(screen.queryByText('Workspace name cannot be empty')).not.toBeInTheDocument()
  })

  it('creates the workspace and closes the form after the message cleared', async () => {
    await openAddDialog()

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Part name'), { target: { value: 'bracket' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    await waitFor(() => expect(screen.getByTitle('bracket')).toBeInTheDocument())
    expect(screen.queryByText('Create New Part')).not.toBeInTheDocument()
  })

  it('seeds the assembly kind on the cover entry when the assembly button is used', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Workspaces', { selector: '.sidebar-item-label' })).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByTitle('New assembly workspace')) })
    expect(screen.getByText('Create New Assembly')).toBeInTheDocument()
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Assembly name'), { target: { value: 'gearbox' } })
    })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })
    await waitFor(() => expect(screen.getByTitle('gearbox')).toBeInTheDocument())

    const store = seedStore()
    const [summary] = await store.list()
    expect(summary.docKind).toBe('assembly')
    const opened = await store.open(summary.workspace)
    const entry = opened.tree.manifest.entries[summary.coverEntry!]
    expect(entry.docKind).toBe('assembly')
  })

  it('creates a part entry with an empty body when the part button is used', async () => {
    await openAddDialog()
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Part name'), { target: { value: 'bracket' } })
    })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })
    await waitFor(() => expect(screen.getByTitle('bracket')).toBeInTheDocument())

    const store = seedStore()
    const [summary] = await store.list()
    expect(summary.docKind).toBe('part')
    const opened = await store.open(summary.workspace)
    expect(opened.tree.contents.get(summary.coverEntry!)?.text).toBe('')
  })
})
