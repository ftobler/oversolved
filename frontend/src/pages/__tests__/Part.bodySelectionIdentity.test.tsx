/**
 * Body-level selections (`@body_...` from the parts list and pick chips) are
 * consumed as if they were feature ids by the Delete key, and addPlane's
 * on_face misses topo-fallback face queries. Pins the selection-body-identity
 * decisions: a picked body inserts a real delete_body feature (no phantom
 * delete_feature), an empty/primitive pick leaves the selection intact, and
 * addPlane accepts any face-resolving selection id.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/utils/core/commandRegistry'

// `vi.hoisted`, because the usePartDoc factory below is hoisted above this line
// and reads the spies while building the module.
const mockHandleMutation = vi.hoisted(() => vi.fn())
const mockCommitMutationGroup = vi.hoisted(() => vi.fn())

const DOC = vi.hoisted(() => ({
  version: 1,
  kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
    { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
    { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: '$sk1', distance: 5, direction: 'normal' } },
  ],
}))
const BODIES = vi.hoisted(() => ({
  body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] },
  body_ex2: { id: 'body_ex2', created_by: 'ex2', modified_by: [] },
}))

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    doc: DOC,
    bodies: BODIES,
    handleMutation: mockHandleMutation,
    commitMutationGroup: mockCommitMutationGroup,
  }))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div>{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))

vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())

vi.mock('../../components/layout/Sidebar', async () =>
  (await import('@/__tests__/test-utils')).sidebarMockModule())

function resetSelection() {
  useSketchEditorStore.setState({
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

async function renderPartInFeatureMode() {
  render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper }
  )
  await screen.findByTitle('Feature mode')
  fireEvent.click(screen.getByTitle('Feature mode'))
}

describe('Delete key on body and feature selections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSelection()
  })

  it('inserts a delete_body feature for a picked body instead of a phantom delete_feature', async () => {
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body_ex1') })
    await act(async () => { executeCommand('delete_selected') })

    const group = mockCommitMutationGroup.mock.calls[0][0]
    expect(group).toHaveLength(1)
    expect(group[0]).toMatchObject({ type: 'add_delete_body', bodies: ['@body_ex1'], label: 'Delete Body' })
  })

  it('skips the body delete when its generator feature is deleted in the same selection', async () => {
    await renderPartInFeatureMode()

    // ex1 GENERATES body_ex1, so deleting both must remove just the feature:
    // a delete_body aimed at the vanished body would fail every later solve.
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@ex1') })
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body_ex1') })
    await act(async () => { executeCommand('delete_selected') })

    const group = mockCommitMutationGroup.mock.calls[0][0]
    expect(group).toEqual([{ type: 'delete_feature', featureId: 'ex1' }])
  })

  it('keeps the body delete when the generator feature is not being deleted', async () => {
    await renderPartInFeatureMode()

    // ex2 GENERATES body_ex2 and is not selected, so the body outlives the
    // selection and its delete_body is still emitted alongside the ex1 delete.
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@ex1') })
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body_ex2') })
    await act(async () => { executeCommand('delete_selected') })

    const group = mockCommitMutationGroup.mock.calls[0][0]
    expect(group).toHaveLength(2)
    expect(group[0]).toMatchObject({ type: 'add_delete_body', bodies: ['@body_ex2'] })
    expect(group[1]).toEqual({ type: 'delete_feature', featureId: 'ex1' })
  })

  it('leaves the selection intact when nothing deletable is picked', async () => {
    await renderPartInFeatureMode()

    // A face primitive of the body is not a whole-body pick, so Delete must
    // neither delete the body nor fabricate a feature delete.
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body_ex1/face/0') })
    await act(async () => { executeCommand('delete_selected') })

    expect(mockCommitMutationGroup).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1/face/0')).toBe(true)
  })

  it('leaves the selection intact for a builtin plane pick', async () => {
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('@builtin_plane_front') })
    await act(async () => { executeCommand('delete_selected') })

    expect(mockCommitMutationGroup).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_front')).toBe(true)
  })
})

// A mixed selection (one sketch entity under the active sketch plus one 3D
// target) must delete BOTH halves in ONE undo entry. The store's own
// deleteSelected only consumes the sketch half and then wipes the whole
// selection, so before this fix the page handler ran second against an empty
// selection and silently dropped the 3D targets: no mutation, no undo entry.
describe('Delete key on a mixed sketch + 3D selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSelection()
  })

  it('folds the sketch delete and the feature delete into ONE commitMutationGroup', async () => {
    await renderPartInFeatureMode()
    // Inside the sketch editor the active feature is the sketch, so the entity
    // target is the half the store consumes and @ex1 is the half it leaves.
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L1', '@ex1']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    // One funnel call carries both halves: the sketch delete the store would
    // have made, and the 3D delete_feature. A separate handleMutation for the
    // sketch half would split this into two history entries.
    expect(mockHandleMutation).not.toHaveBeenCalled()
    expect(mockCommitMutationGroup).toHaveBeenCalledOnce()
    const group = mockCommitMutationGroup.mock.calls[0][0]
    expect(group).toContainEqual({ type: 'delete', targets: ['entity:sk1:L1'] })
    expect(group).toContainEqual({ type: 'delete_feature', featureId: 'ex1' })
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('folds the sketch delete and a body delete_body into ONE commitMutationGroup', async () => {
    await renderPartInFeatureMode()
    // ex2 GENERATES body_ex2 and is NOT selected, so the body outlives its
    // generator here and keeps a real delete_body beside the sketch delete.
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L1', '@body_ex2']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    expect(mockHandleMutation).not.toHaveBeenCalled()
    expect(mockCommitMutationGroup).toHaveBeenCalledOnce()
    const group = mockCommitMutationGroup.mock.calls[0][0]
    expect(group).toContainEqual({ type: 'delete', targets: ['entity:sk1:L1'] })
    expect(group).toContainEqual(expect.objectContaining({ type: 'add_delete_body', bodies: ['@body_ex2'] }))
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('a sketch entity alone still routes through the store delete (one handleMutation, no group)', async () => {
    await renderPartInFeatureMode()
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L1']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    // Sketch-only is unchanged: the store's own deleteSelected dispatches via
    // onMutation (handleMutation) and the page handler adds no group of its own.
    expect(mockCommitMutationGroup).not.toHaveBeenCalled()
    expect(mockHandleMutation).toHaveBeenCalledOnce()
    expect(mockHandleMutation).toHaveBeenCalledWith({ type: 'delete', targets: ['entity:sk1:L1'] })
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})

describe('Add plane on a face selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSelection()
  })

  it('defines an on_face plane from a topo-fallback @body/face/N pick', async () => {
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body0/face/0') })
    fireEvent.click(screen.getByTitle('Add plane'))

    expect(mockHandleMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add_plane',
        definition: { mode: 'on_face', face: '@body0/face/0' },
      })
    )
  })

  it('defines an on_face plane from a face: wrapper, storing its inner query', async () => {
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('face:ex1:?8,8;@ex1f0:face') })
    fireEvent.click(screen.getByTitle('Add plane'))

    expect(mockHandleMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add_plane',
        definition: { mode: 'on_face', face: '?8,8;@ex1f0:face' },
      })
    )
  })

  it('still defines an on_face plane from a bare ancestry query', async () => {
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('?9;@ex1face0:face') })
    fireEvent.click(screen.getByTitle('Add plane'))

    expect(mockHandleMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add_plane',
        definition: { mode: 'on_face', face: '?9;@ex1face0:face' },
      })
    )
  })

  it('defines an on_face plane from a flatface ancestry query', async () => {
    // Real planar picks carry the OCC surface type as the type restriction
    // (`:flatface`), which the old `:face` substring test never matched.
    await renderPartInFeatureMode()

    act(() => { useSketchEditorStore.getState().addToNormalSelection('?9;@ex1face0:flatface') })
    fireEvent.click(screen.getByTitle('Add plane'))

    expect(mockHandleMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add_plane',
        definition: { mode: 'on_face', face: '?9;@ex1face0:flatface' },
      })
    )
  })
})
