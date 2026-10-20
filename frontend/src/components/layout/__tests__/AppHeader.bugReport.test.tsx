import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import { useBugReportStore } from '@/stores/bugReportStore'
import { editorState } from '@/stores/editorState'

function wrap(ui: ReactNode = <AppHeader title="Test" />) {
  return render(<MemoryRouter initialEntries={['/workspaces']}>{ui}</MemoryRouter>)
}

beforeEach(() => {
  useBugReportStore.getState().discard()
})

afterEach(() => {
  act(() => {
    useBugReportStore.getState().discard()
    editorState.setState({ normalSelection: new Set() })
  })
})

describe('AppHeader bug report', () => {
  it('opens the report store from the header button', () => {
    wrap()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }))
    })
    expect(useBugReportStore.getState().open).toBe(true)
    expect(screen.getByText('Report a bug')).toBeInTheDocument()
  })

  it('seeds the first set from the current selection', () => {
    act(() => { editorState.setState({ normalSelection: new Set(['@ex1']) }) })
    wrap()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }))
    })
    const sets = useBugReportStore.getState().sets
    expect(sets).toHaveLength(1)
    expect(sets[0].name).toBe('selection')
    expect(sets[0].picks.map(p => p.query)).toEqual(['@ex1'])
    act(() => { editorState.setState({ normalSelection: new Set() }) })
  })

  it('mounts the non-part panel with picking disabled', () => {
    useBugReportStore.getState().openReport([])
    useBugReportStore.getState().addSet()
    wrap()
    expect(screen.getByText('Open a part to pick')).toBeInTheDocument()
    expect(document.querySelector('.bug-report-panel--header')).not.toBeNull()
  })

  it('leaves the mount to the part editor when asked', () => {
    wrap(<AppHeader title="Test" mountBugReport={false} />)
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }))
    })
    // The header button still opens the shared draft; the part editor's own
    // overlay is the only card that draws it.
    expect(useBugReportStore.getState().open).toBe(true)
    expect(screen.queryByText('Report a bug')).not.toBeInTheDocument()
  })
})
