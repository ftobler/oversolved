// The undo/redo buttons and tooltips against the PRODUCTION PartToolbar. The
// old suite tested a local copy of the slice(-5).reverse() item selection, so a
// regression in PartToolbar's real stacking logic could pass every test. The
// stacks are seeded straight into partEditorStore (the mirror that populates
// it is covered separately in useSyncPartEditorStore.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import PartToolbar from '@/pages/PartToolbar'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { registerCommand, clearAllHandlers } from '@/utils/core/commandRegistry'
import type { Mutation } from '@/types/cad'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderToolbar() {
  return render(
    <PartToolbar
      docName="TestDoc"
      onRename={vi.fn()}
      handleSave={vi.fn()}
      handleClone={vi.fn()}
    />,
  )
}

function entry(label: string): { doc: unknown; mutation: Mutation } {
  return { doc: { version: 1, kind: 'part' }, mutation: { type: 'rename_feature', featureId: 'f1', label } as Mutation }
}

const undoButton = () => screen.getByRole('button', { name: 'Undo' })
const redoButton = () => screen.getByRole('button', { name: 'Redo' })

// The real registry, wired to real stack moves: clicking a toolbar button has
// to reach a handler and shift the store's history, not just call a spy.
function stepHistory(direction: 'undo' | 'redo') {
  const { undoStack, redoStack } = usePartEditorStore.getState()
  const from = direction === 'undo' ? undoStack : redoStack
  if (from.length === 0) return
  const entry = from[from.length - 1]
  usePartEditorStore.setState(
    direction === 'undo'
      ? { undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, entry] }
      : { undoStack: [...undoStack, entry], redoStack: redoStack.slice(0, -1) },
  )
}

describe('PartToolbar undo/redo', () => {
  beforeEach(() => {
    clearAllHandlers()
    registerCommand('undo', () => stepHistory('undo'))
    registerCommand('redo', () => stepHistory('redo'))
    usePartEditorStore.setState({ undoStack: [], redoStack: [] })
  })

  afterEach(() => {
    clearAllHandlers()
  })

  it('disables undo and redo when both stacks are empty', () => {
    renderToolbar()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(true)
    expect((redoButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables undo when the undo stack has entries and redo when the redo stack has entries', () => {
    usePartEditorStore.setState({ undoStack: [entry('a')], redoStack: [entry('b')] })
    renderToolbar()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(false)
    expect((redoButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('clicking undo routes through the registry and moves the entry onto redo', () => {
    usePartEditorStore.setState({ undoStack: [entry('a')], redoStack: [] })
    renderToolbar()
    fireEvent.click(undoButton())
    expect(usePartEditorStore.getState().undoStack).toHaveLength(0)
    expect(usePartEditorStore.getState().redoStack).toHaveLength(1)
  })

  it('clicking redo routes through the registry and moves the entry onto undo', () => {
    usePartEditorStore.setState({ undoStack: [], redoStack: [entry('b')] })
    renderToolbar()
    fireEvent.click(redoButton())
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
    expect(usePartEditorStore.getState().redoStack).toHaveLength(0)
  })

  it('the undo tooltip shows the up-to-five most recent actions, most recent first', () => {
    const stacks = Array.from({ length: 10 }, (_, i) => entry(`sk${i}`))
    usePartEditorStore.setState({ undoStack: stacks, redoStack: [] })
    renderToolbar()

    fireEvent.mouseEnter(undoButton())

    expect(screen.getByText('Undo (10) Ctrl+Z')).toBeTruthy()
    // Production logic: undoStack.slice(-5).reverse() -> sk9 first, sk5 last.
    expect(screen.getByText('rename f1 to sk9')).toBeTruthy()
    expect(screen.getByText('rename f1 to sk8')).toBeTruthy()
    expect(screen.getByText('rename f1 to sk7')).toBeTruthy()
    expect(screen.getByText('rename f1 to sk6')).toBeTruthy()
    expect(screen.getByText('rename f1 to sk5')).toBeTruthy()
    expect(screen.queryByText('rename f1 to sk4')).toBeNull()
  })

  it('the redo tooltip shows the redo stack and the undo one does not leak into it', () => {
    usePartEditorStore.setState({
      undoStack: [entry('undone')],
      redoStack: [entry('redone')],
    })
    renderToolbar()

    fireEvent.mouseEnter(redoButton())

    expect(screen.getByText('Redo (1) Ctrl+Shift+Z')).toBeTruthy()
    expect(screen.getByText('rename f1 to redone')).toBeTruthy()
    expect(screen.queryByText('rename f1 to undone')).toBeNull()
  })

  it('an empty stack shows no tooltip on hover', () => {
    renderToolbar()
    fireEvent.mouseEnter(undoButton())
    expect(screen.queryByText(/Ctrl\+Z/)).toBeNull()
  })
})
