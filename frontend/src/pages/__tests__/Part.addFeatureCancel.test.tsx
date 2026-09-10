// L8: Cancel on a feature that was just added must discard the add, exactly as
// it discards a pre-existing feature's in-session edits. The add+enter path used
// to skip startEditSession, so the session snapshot Cancel depends on was never
// taken and the new feature survived the Cancel.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

// The built-ins (Origin + three planes) are always prepended on load, so the
// assertions scope to user features.
const userFeatures = () =>
  usePartEditorStore.getState().features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

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

describe('Part - Cancel on a just-added feature reverts the add', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
    partDocStoreMock()
  })

  async function addFeatureAndWait(title: string) {
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle(title)) })
    await waitFor(() => expect(userFeatures()).toHaveLength(1))
    await waitFor(() => expect(screen.getByTitle('Cancel')).toBeInTheDocument())
  }

  it('Cancel on a just-added extrude removes it', async () => {
    await addFeatureAndWait('Add Extrude (E)')
    expect(userFeatures().map(f => f.kind)).toEqual(['extrude'])

    await act(async () => { fireEvent.click(screen.getByTitle('Cancel')) })

    await waitFor(() => expect(userFeatures()).toHaveLength(0))
  })

  it('Cancel on a just-added plane removes it', async () => {
    await addFeatureAndWait('Add plane')
    expect(userFeatures().map(f => f.kind)).toEqual(['plane'])

    await act(async () => { fireEvent.click(screen.getByTitle('Cancel')) })

    await waitFor(() => expect(userFeatures()).toHaveLength(0))
  })

  it('OK on a just-added extrude commits exactly one entry that undo removes', async () => {
    await addFeatureAndWait('Add Extrude (E)')

    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack).toHaveLength(1))

    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(userFeatures()).toHaveLength(0))
  })

  it('adding a second feature while the first is editing commits the first, and Cancel removes only the second', async () => {
    await addFeatureAndWait('Add Extrude (E)')

    // The one-open-editor guard commits the extrude so the second add starts a
    // fresh session instead of tripping the nested-session guard.
    await act(async () => { fireEvent.click(screen.getByTitle('Add Revolve')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(2))
    expect(userFeatures().map(f => f.kind)).toEqual(['extrude', 'revolve'])
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByTitle('Cancel')) })
    await waitFor(() => expect(userFeatures().map(f => f.kind)).toEqual(['extrude']))
    // The committed first add is untouched by the second's Cancel.
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
  })

  it('adding a feature while another editor is open costs exactly one solve, not two', async () => {
    await addFeatureAndWait('Add Extrude (E)')
    vi.mocked(solveViaWorker).mockClear()

    // closeOpenEditorForAdd commits and resets the open session without a
    // re-solve, so the second add's own funnel is the only solve.
    await act(async () => { fireEvent.click(screen.getByTitle('Add Revolve')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(2))

    expect((solveViaWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('adding a sketch while a just-added extrude editor is open keeps the two adds as separate entries', async () => {
    await addFeatureAndWait('Add Extrude (E)')

    // The guard commits the extrude before the sketch add, so the sketch is not
    // swallowed into the extrude's session and one undo cannot remove both.
    await act(async () => { fireEvent.click(screen.getByTitle('Sketch')) })
    await waitFor(() => expect(userFeatures().filter(f => f.kind === 'sketch')).toHaveLength(1))
    await waitFor(() => expect(usePartEditorStore.getState().undoStack).toHaveLength(2))

    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(userFeatures().filter(f => f.kind === 'sketch')).toHaveLength(0))
    expect(userFeatures().filter(f => f.kind === 'extrude')).toHaveLength(1)
  })

  it('Ctrl+Z while a just-added extrude editor is open removes the just-added feature', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))
    // Seed a prior real step so the undo has something to pop and reaches the
    // open session instead of no-opping on an empty stack.
    await act(async () => { executeCommand('toggle_sketch_plane_visibility') })
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(userFeatures().map(f => f.kind)).toEqual(['extrude']))
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { executeCommand('undo') })

    // The undo restored the pre-add doc and tore the session down: the feature
    // is gone, not just its editor.
    await waitFor(() => expect(userFeatures().filter(f => f.kind === 'extrude')).toHaveLength(0))
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
  })
})
