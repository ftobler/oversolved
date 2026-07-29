import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'


vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

describe('Part - eliminate redundant solves', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function countSolveCalls(): number {
    return (solveViaWorker as ReturnType<typeof vi.fn>).mock.calls.length
  }

  async function renderAndWaitForLoad() {
    vi.stubGlobal('fetch', partDocFetchMock())

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // The doc loads empty (features: []), which needs no solve, so wait for the
    // toolbar to mount rather than for a solve call.
    await screen.findByTitle('Feature mode')
  }

  it('adds extrude with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds revolve with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Revolve'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds hole with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Hole'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds sketch with exactly 2 solves (add + auto-enter-edit preview)', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Sketch'))

    // Adding a sketch also auto-enters sketch edit, which fires a second
    // (preview) solve. Previously the IndexedDB build cache short-circuited
    // that second solve before it reached the worker; with the cache removed
    // it now runs through the local kernel (fast, checkpoint-cached).
    await waitFor(() => {
      expect(countSolveCalls()).toBe(2)
    })
  })

  it('adds extrude then sketch with exactly 2 total solves', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })

    fireEvent.click(screen.getByTitle('Sketch'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(2)
    })
  })

  it('user rollback change triggers exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })

    // Adding a feature enters edit mode on it, and the rollback bar is not
    // draggable while editing. Commit the edit first, then drag.
    fireEvent.click(screen.getByTitle('OK'))
    await waitFor(() => {
      expect(countSolveCalls()).toBe(2)
    })

    vi.mocked(solveViaWorker).mockClear()

    // The bar drags on pointer events: press it, release over another slot.
    // jsdom reports zero rects, so lay the rows out as a 40px stack first.
    document.querySelectorAll('.feature-item').forEach((el, i) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        top: i * 40, bottom: i * 40 + 40, height: 40,
        left: 0, right: 200, width: 200, x: 0, y: i * 40,
        toJSON: () => {},
      })
    })
    const bar = () => screen.getAllByTitle('Rollback')[0]

    // Park the bar before the extrude first. That leaves nothing to solve, so
    // it issues no worker call -- it only sets up a bar position to drag back.
    fireEvent(bar(), new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    fireEvent(window, new MouseEvent('pointerup', { clientY: 10 }))

    vi.mocked(solveViaWorker).mockClear()

    fireEvent(bar(), new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    fireEvent(window, new MouseEvent('pointerup', { clientY: 500 }))  // back to the end

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })
})
