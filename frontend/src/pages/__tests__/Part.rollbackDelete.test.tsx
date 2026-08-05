import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

const THREE_FEATURE_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: sketch 1
  - id: ex1
    kind: extrude
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: ex2
    kind: extrude
    extrude: { sketch: '$sk1', distance: 5, direction: 'normal' }
`

describe('rollback position clamping on feature delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps rollback bar visible after deleting a feature', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: THREE_FEATURE_DOC }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // Wait for the doc to load and features to render
    await waitFor(() => {
      expect(screen.getByText('sketch 1')).toBeInTheDocument()
    })

    // Initially there should be a rollback bar at the end of the list
    await waitFor(() => {
      const rollbackBars = screen.getAllByTitle('Rollback')
      expect(rollbackBars.length).toBeGreaterThan(0)
    })

    // Click the "More options" button to open context menu
    const featureItem = screen.getByText('sketch 1').closest('.feature-item')!
    const moreBtn = featureItem.querySelector('.feature-context-btn') as HTMLElement
    fireEvent.click(moreBtn)

    // Wait for context menu to appear and click Delete
    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Delete'))

    // Wait for the feature to be removed
    await waitFor(() => {
      expect(screen.queryByText('sketch 1')).not.toBeInTheDocument()
    })

    // After fix: rollback bar should still be visible at the end
    await waitFor(() => {
      const rollbackBars = screen.getAllByTitle('Rollback')
      expect(rollbackBars.length).toBeGreaterThan(0)
    })
  })

  it('clamps rollback position when multiple features are deleted', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: THREE_FEATURE_DOC }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('sketch 1')).toBeInTheDocument()
    })

    // Delete first feature
    const featureItem1 = screen.getByText('sketch 1').closest('.feature-item')!
    fireEvent.click(featureItem1.querySelector('.feature-context-btn') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.queryByText('sketch 1')).not.toBeInTheDocument()
    })

    // Delete second feature
    const featureItem2 = screen.getByText('ex1').closest('.feature-item')!
    fireEvent.click(featureItem2.querySelector('.feature-context-btn') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.queryByText('extrude 1')).not.toBeInTheDocument()
    })

    // Rollback bar should still be visible
    const rollbackBars = screen.getAllByTitle('Rollback')
    expect(rollbackBars.length).toBeGreaterThan(0)
  })
})
