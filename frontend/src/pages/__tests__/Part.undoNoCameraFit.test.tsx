import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

// `vi.hoisted`, because the mock factory below is hoisted above this line and
// reads the spies while building the module.
const mockAutoZoomToFit = vi.hoisted(() => vi.fn())
const mockCancelPendingFit = vi.hoisted(() => vi.fn())

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({
    autoZoomToFit: mockAutoZoomToFit,
    cancelPendingFit: mockCancelPendingFit,
  }))

describe('Part - undo/redo never move the camera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', partDocFetchMock())
  })

  it('disarms any pending fit on undo/redo and does not re-fit', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // First solve frames the document exactly once.
    await waitFor(() => {
      expect(mockAutoZoomToFit).toHaveBeenCalledOnce()
    })
    mockAutoZoomToFit.mockClear()

    // Undo and redo must disarm the pending fit and never reframe the camera,
    // even when their stacks are empty (the guarantee is unconditional).
    act(() => {
      executeCommand('undo')
      executeCommand('redo')
    })

    expect(mockCancelPendingFit).toHaveBeenCalledTimes(2)
    expect(mockAutoZoomToFit).not.toHaveBeenCalled()
  })
})
