import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { Wrapper } from '@/__tests__/test-utils'
import { backendBundle } from '@/adapters/backend'

const mockAutoZoomToFit = vi.hoisted(() => vi.fn())

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ autoZoomToFit: mockAutoZoomToFit }))

const DOC_A = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: A feature
`

const DOC_B = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: B feature
`

function stubTwoDocStore() {
  const docs: Record<string, { content: string; name: string }> = {
    A: { content: DOC_A, name: 'Doc A' },
    B: { content: DOC_B, name: 'Doc B' },
  }
  return vi.spyOn(backendBundle.documents, 'load').mockImplementation(async (id: string) => {
    const doc = docs[id]
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
  })
}

function KeyedPartHost() {
  const { uuid } = useParams<{ uuid: string }>()
  return <Part key={uuid} />
}

function GoToB() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/documents/B')}>to B</button>
}

describe('Part - auto-fit arms on every document first solve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
    useSketchEditorStore.setState({ activePickField: null, modeStack: [] })
  })

  it('arms auto-fit on the second document too, after a keyed remount', async () => {
    stubTwoDocStore()

    render(
      <MemoryRouter initialEntries={['/documents/A']}>
        <Routes>
          <Route path="/documents/:uuid" element={<KeyedPartHost />} />
        </Routes>
        <GoToB />
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => { expect(mockAutoZoomToFit).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    await waitFor(() => { expect(mockAutoZoomToFit).toHaveBeenCalledTimes(2) })
  })
})