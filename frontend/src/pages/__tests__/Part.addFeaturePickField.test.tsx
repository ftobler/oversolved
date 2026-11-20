// Adding a feature opens its editor with the first field already armed. A part
// field must arm as a part pick, or the Parts card keeps showing the preview and
// the row click cannot feed the chip of the feature the user was just handed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useEditorState.setState({
    editingFeatureId: null,
    pickBoundary: null,
    rollbackPosition: null,
    activePickField: null,
    modeStack: [],
  })
  partDocStoreMock()
})

describe('Part - a new feature arms its first pick field', () => {
  it('adding a Transform arms its part field as a part pick', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await act(async () => { fireEvent.click(screen.getByTitle('Add Transform')) })

    await waitFor(() => expect(useEditorState.getState().activePickField).toMatchObject({
      field: 'bodies', multi: true, names: 'body',
    }))
  })

  it('adding an Extrude still arms its sketch field, not a part pick', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })

    await waitFor(() => expect(useEditorState.getState().activePickField).toMatchObject({
      field: 'sketch', multi: true,
    }))
    expect(useEditorState.getState().activePickField?.names).toBeUndefined()
  })
})
