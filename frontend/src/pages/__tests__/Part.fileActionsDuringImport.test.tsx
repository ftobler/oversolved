/**
 * The STEP import is an add path, so it closes any open feature editor before
 * the import lands. The header gate disables Import STEP (and Export) while
 * editingFeatureId is set, so the obvious mid-edit click is gone, but the
 * picker leaves an async window: the button is clicked while enabled, then the
 * user picks a file, and an edit can open while onchange awaits the read and
 * the registry write. These tests drive that window directly and pin that the
 * defensive close still commits the open edit and records the import as its
 * own undo step, while a failed read or registry write leaves the edit alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

const mockSolveViaWorker = vi.hoisted(() => vi.fn())
const mockRegistryCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'file-1' })))
const mockOpenExport = vi.hoisted(() => vi.fn())

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

// The export dialog is out of scope here; the handle records the open call the
// disabled button must not make.
vi.mock('@/pages/PartExportImport', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: React.forwardRef(function PartExportImportMock(_props: unknown, ref: import('react').Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ openExport: mockOpenExport }))
      return null
    }),
  }
})

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

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper }
  )
}

const importButton = () => screen.getByRole('button', { name: 'Import STEP' }) as HTMLButtonElement
const exportButton = () => screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement

function installPickerSpies() {
  const created: HTMLInputElement[] = []
  const make = document.createElement.bind(document)
  const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = make(tag as never, opts)
    if (tag === 'input') created.push(el as HTMLInputElement)
    return el
  }) as typeof document.createElement)
  const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  return {
    created,
    clicked: clickSpy,
    restore: () => { createSpy.mockRestore(); clickSpy.mockRestore() },
  }
}

function openPicker() {
  const picker = installPickerSpies()
  fireEvent.click(importButton())
  const input = picker.created[0]
  expect(input).toBeTruthy()
  return { input, ...picker }
}

async function chooseFile(
  input: HTMLInputElement,
  file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { await input.onchange?.(new Event('change')) })
}

async function importStep(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }) {
  const picker = openPicker()
  await chooseFile(picker.input, file)
  picker.restore()
}

async function openFeatureEdit() {
  fireEvent.click(screen.getByTitle('Feature mode'))
  await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
  fireEvent.click(screen.getByTitle('Edit extrude'))
  await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBe('ex1'))
}

async function openSketchEdit() {
  fireEvent.click(screen.getByTitle('Feature mode'))
  await waitFor(() => expect(screen.getByText('Sketch 1')).toBeInTheDocument())
  fireEvent.click(screen.getByTitle('Edit sketch'))
  await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBe('sk1'))
}

async function cancelOpenEdit() {
  const panel = within(document.querySelector('.feature-edit-panel') as HTMLElement)
  fireEvent.click(panel.getByTitle('Cancel'))
  await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBeNull())
}

describe('Part - file actions and STEP import around an open edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorState.setState({
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
    mockSolveViaWorker.mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null })
    mockRegistryCreate.mockResolvedValue({ id: 'file-1' })
    partDocStoreMock({ content: DOC, name: 'Bracket' })
  })

  it('disables Import STEP and Export during a feature edit and runs neither', async () => {
    renderPart()
    await openFeatureEdit()

    expect(importButton()).toBeDisabled()
    expect(exportButton()).toBeDisabled()

    const picker = installPickerSpies()
    fireEvent.click(importButton())
    fireEvent.click(exportButton())
    // A disabled button swallows the click: no picker is created and the
    // export dialog never opens.
    expect(picker.created).toHaveLength(0)
    expect(picker.clicked).not.toHaveBeenCalled()
    expect(mockOpenExport).not.toHaveBeenCalled()
    picker.restore()
  })

  it('closes an editor opened while the picked file is still being committed and records its own undo step', async () => {
    renderPart()
    // The click happens while no edit is open, so the header gate lets it
    // through and the native picker is created. The edit opens before the
    // async onchange runs, which is the window the gate cannot cover.
    const picker = openPicker()
    expect(importButton()).toBeEnabled()

    await openFeatureEdit()
    const undoBefore = usePartEditorStore.getState().undoStack.length

    await chooseFile(picker.input, { name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    // closeOpenEditorForAdd committed the edit first, so the import is its own
    // step rather than being swallowed into the open session.
    await waitFor(() => expect(userFeatures().some(f => f.kind === 'import_step')).toBe(true))
    expect(useEditorState.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().undoStack.length).toBe(undoBefore + 1)
    picker.restore()
  })

  it('a rejected registry create leaves an editor opened during the picker untouched', async () => {
    renderPart()
    const picker = openPicker()
    await openFeatureEdit()
    const undoBefore = usePartEditorStore.getState().undoStack.length
    const rollback = useEditorState.getState().rollbackPosition

    mockRegistryCreate.mockRejectedValueOnce(new Error('quota exceeded'))
    await chooseFile(picker.input, { name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    await waitFor(() => expect(screen.getByText(/quota exceeded/)).toBeInTheDocument())
    // The failure never reached closeOpenEditorForAdd: the session, its bar and
    // its history entry are all still standing, and nothing was imported.
    expect(useEditorState.getState().editingFeatureId).toBe('ex1')
    expect(useEditorState.getState().rollbackPosition).toBe(rollback)
    expect(usePartEditorStore.getState().undoStack.length).toBe(undoBefore)
    expect(userFeatures().some(f => f.kind === 'import_step')).toBe(false)
    picker.restore()
  })

  it('a failed read leaves an editor opened during the picker untouched', async () => {
    renderPart()
    const picker = openPicker()
    await openFeatureEdit()
    const undoBefore = usePartEditorStore.getState().undoStack.length

    await chooseFile(picker.input, {
      name: 'bracket.step',
      size: 32,
      arrayBuffer: async () => { throw new Error('io') },
    })

    await waitFor(() => expect(screen.getByText(/Failed to read STEP file/)).toBeInTheDocument())
    expect(mockRegistryCreate).not.toHaveBeenCalled()
    expect(useEditorState.getState().editingFeatureId).toBe('ex1')
    expect(usePartEditorStore.getState().undoStack.length).toBe(undoBefore)
    expect(userFeatures().some(f => f.kind === 'import_step')).toBe(false)
    picker.restore()
  })

  it('closing a feature edit re-enables both without a remount and the import lands', async () => {
    renderPart()
    await openFeatureEdit()
    const before = importButton()

    await cancelOpenEdit()

    expect(importButton()).toBe(before)
    expect(importButton()).toBeEnabled()
    expect(exportButton()).toBeEnabled()

    const undoBefore = usePartEditorStore.getState().undoStack.length
    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    await waitFor(() => expect(userFeatures().some(f => f.kind === 'import_step')).toBe(true))
    expect(usePartEditorStore.getState().undoStack.length).toBe(undoBefore + 1)
  })

  it('disables the pair during a sketch edit and re-enables it on cancel', async () => {
    renderPart()
    await openSketchEdit()

    expect(importButton()).toBeDisabled()
    expect(exportButton()).toBeDisabled()

    await cancelOpenEdit()

    expect(importButton()).toBeEnabled()
    expect(exportButton()).toBeEnabled()
  })

  it('export is available again after the edit closes', async () => {
    renderPart()
    await openFeatureEdit()
    fireEvent.click(exportButton())
    expect(mockOpenExport).not.toHaveBeenCalled()

    await cancelOpenEdit()
    fireEvent.click(exportButton())

    expect(mockOpenExport).toHaveBeenCalledWith(null, 'Bracket')
  })
})
