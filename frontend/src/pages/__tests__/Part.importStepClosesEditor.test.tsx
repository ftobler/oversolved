/**
 * A STEP import is an add path, so -- like extrude, hole, transform and sketch
 * -- it must close any open feature editor before it lands. It used to be the
 * one add path that skipped closeOpenEditorForAdd, so with an editor open the
 * import was swallowed into the open session's suppressed aggregate and the
 * rollback mirror (gated on editingFeatureId === null) never wrote doc.rollback:
 * the imported feature sat past the bar, styled rolled back and sliced from
 * every solve. Uses the real usePartDoc so the editor session, the mirror and
 * the undo stack compose the way they do in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

const mockSolveViaWorker = vi.hoisted(() => vi.fn())
const mockRegistryCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'file-1' })))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: mockSolveViaWorker,
  cancelSolver: vi.fn(),
}))

vi.mock('@/stores/fileRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/fileRegistry')>()
  return { ...actual, getFileRegistry: () => ({ create: mockRegistryCreate }) }
})

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

const userFeatures = () =>
  usePartEditorStore.getState().features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

async function importStep(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }) {
  const created: HTMLInputElement[] = []
  const make = document.createElement.bind(document)
  const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = make(tag as never, opts)
    if (tag === 'input') created.push(el as HTMLInputElement)
    return el
  }) as typeof document.createElement)
  const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

  fireEvent.click(screen.getByTitle('Import STEP'))

  const input = created[0]
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { await input.onchange?.(new Event('change')) })

  createSpy.mockRestore()
  clickSpy.mockRestore()
}

describe('Part - importing a STEP while a feature editor is open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
    mockSolveViaWorker.mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null })
    mockRegistryCreate.mockResolvedValue({ id: 'file-1' })
    partDocStoreMock({ content: DOC })
  })

  it('closes the open editor first and records the import as its own undo step', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Feature mode'))

    // Open the extrude editor: a suppressed session with the bar pinned after it.
    fireEvent.click(screen.getByTitle('Edit extrude'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1'))
    const before = usePartEditorStore.getState().undoStack.length

    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    // The editor closed first, so the import is a real step of its own rather
    // than being swallowed into the session: editingFeatureId is null and the
    // undo stack grew by exactly one entry.
    await waitFor(() => expect(userFeatures().some(f => f.kind === 'import_step')).toBe(true))
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().undoStack.length).toBe(before + 1)
  })

  // The registry create sits before closeOpenEditorForAdd, so a failed write
  // (quota, a closed DB) leaves the open editor and its session exactly as they
  // were: the user is not bounced out of an unrelated edit by an import that
  // never landed. The read rejection is before even that.
  it('a rejected registry create leaves the open editor and its session untouched', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Feature mode'))

    fireEvent.click(screen.getByTitle('Edit extrude'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1'))
    const before = usePartEditorStore.getState().undoStack.length
    const rollback = usePartEditorStore.getState().rollbackPosition

    mockRegistryCreate.mockRejectedValueOnce(new Error('quota exceeded'))
    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    await waitFor(() => expect(screen.getByText(/quota exceeded/)).toBeInTheDocument())
    // The failure never reached closeOpenEditorForAdd: the session, its bar and
    // its history entry are all still standing, and nothing was imported.
    expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1')
    expect(usePartEditorStore.getState().rollbackPosition).toBe(rollback)
    expect(usePartEditorStore.getState().undoStack.length).toBe(before)
    expect(userFeatures().some(f => f.kind === 'import_step')).toBe(false)
  })

  it('a failed read leaves the open editor and its session untouched', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Feature mode'))

    fireEvent.click(screen.getByTitle('Edit extrude'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1'))
    const before = usePartEditorStore.getState().undoStack.length

    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => { throw new Error('io') } })

    await waitFor(() => expect(screen.getByText(/Failed to read STEP file/)).toBeInTheDocument())
    expect(mockRegistryCreate).not.toHaveBeenCalled()
    expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1')
    expect(usePartEditorStore.getState().undoStack.length).toBe(before)
    expect(userFeatures().some(f => f.kind === 'import_step')).toBe(false)
  })

  it('with no editor open still records exactly one import step', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Feature mode'))
    const before = usePartEditorStore.getState().undoStack.length

    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    await waitFor(() => expect(userFeatures().some(f => f.kind === 'import_step')).toBe(true))
    expect(usePartEditorStore.getState().undoStack.length).toBe(before + 1)
  })
})
