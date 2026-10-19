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

// A second downstream feature gives the delete a mid-stack slot to insert at.
const ROLLED_BACK_DOC = `version: 1
kind: part
rollback: 2
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: f2
    kind: fillet
    label: Fillet 1
    edges: []
    radius: 1
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

async function mountPart(content = DOC) {
  partDocStoreMock({ content })
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

  it('inserts the delete_face at the rollback bar and solves it in the same press', async () => {
    await mountPart(ROLLED_BACK_DOC)
    await waitFor(() => expect(useEditorState.getState().rollbackPosition).toBe(2))
    act(() => {
      useEditorState.setState({ normalSelection: new Set([FACE_A]) })
    })
    await act(async () => { executeCommand('delete_selected') })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack).toHaveLength(1))

    const features = currentFeatures()
    const deleteFace = features.find(f => f.kind === 'delete_face')!
    expect(features.map(f => f.kind)).toEqual(['sketch', 'extrude', 'delete_face', 'fillet'])
    expect(useEditorState.getState().rollbackPosition).toBe(3)
    expect(usePartEditorStore.getState().doc?.rollback).toBe(3)

    // The delete feature is inside the same solve, and the bar stops at it:
    // the downstream fillet stays rolled back.
    const calls = mockSolveViaWorker.mock.calls
    const payload = calls[calls.length - 1][0] as {
      features: { id: string }[]
      rollback_position: number
    }
    expect(payload.features.map(f => f.id)).toContain(deleteFace.id)
    expect(payload.features.map(f => f.id)).not.toContain('f2')
    expect(payload.rollback_position).toBe(3)
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
