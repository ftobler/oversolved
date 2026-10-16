/**
 * The Delete-key rule for face selections: pressing Delete with faces selected
 * inserts ONE delete_face feature seeded with every picked face, alongside any
 * feature delete, inside one commitMutationGroup so the whole press is one undo
 * entry. An edge-only selection stays ignored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

const mockSolveViaWorker = vi.hoisted(() => vi.fn())

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: mockSolveViaWorker,
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
`

const BODIES = { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] } }

const FACE_A = '?4;@ex1:flatface'
const FACE_B = '?9;@body_ex1:cylinderface'

function resetSelection() {
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    activeFeatureId: null,
    activeTool: null,
    activePickField: null,
    modeStack: [],
  })
}

function currentFeatures(): { id: string; kind: string; delete_face?: { faces: string[] } }[] {
  return usePartEditorStore.getState().features as unknown as { id: string; kind: string; delete_face?: { faces: string[] } }[]
}

async function mountPart() {
  partDocStoreMock({ content: DOC })
  render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(usePartEditorStore.getState().bodies?.body_ex1).toBeTruthy())
  fireEvent.click(screen.getByTitle('Feature mode'))
}

describe('Delete key on a face selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSelection()
    mockSolveViaWorker.mockResolvedValue({ result: {}, bodies: BODIES, pick_bodies: {}, _build_state: null })
  })

  it('folds two faces of one body plus a feature into one group and one undo entry', async () => {
    await mountPart()
    act(() => {
      useEditorState.setState({ normalSelection: new Set([FACE_A, FACE_B, '@ex1']) })
    })
    await act(async () => { executeCommand('delete_selected') })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack).toHaveLength(1))

    const features = currentFeatures()
    const deleteFaces = features.filter(f => f.kind === 'delete_face')
    expect(deleteFaces).toHaveLength(1)
    expect(deleteFaces[0].delete_face!.faces).toEqual([FACE_A, FACE_B])
    expect(features.some(f => f.id === 'ex1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
  })

  it('a face selection alone inserts exactly one delete_face with both faces', async () => {
    await mountPart()
    act(() => {
      useEditorState.setState({ normalSelection: new Set([FACE_A, FACE_B]) })
    })
    await act(async () => { executeCommand('delete_selected') })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack).toHaveLength(1))

    const features = currentFeatures()
    expect(features.filter(f => f.kind === 'delete_face')).toHaveLength(1)
    expect(features.find(f => f.kind === 'delete_face')!.delete_face!.faces).toEqual([FACE_A, FACE_B])
  })

  it('an edge-only selection inserts no delete_face', async () => {
    await mountPart()
    act(() => {
      useEditorState.setState({ normalSelection: new Set(['?9;@body_ex1:straightedge']) })
    })
    await act(async () => { executeCommand('delete_selected') })

    // No 3D work: the sketch store's own deleteSelected runs and no-ops on a
    // non-deletable pick, so there is no delete_face feature and no entry.
    const features = currentFeatures()
    expect(features.some(f => f.kind === 'delete_face')).toBe(false)
  })
})
