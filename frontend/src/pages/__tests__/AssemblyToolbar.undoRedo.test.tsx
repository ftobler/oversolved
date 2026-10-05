// The undo/redo buttons and tooltips against the PRODUCTION AssemblyToolbar.
// The stacks are seeded straight into assemblyStore (the page's mutate pushes
// into it; the hook that drives it is covered in useAssemblyUndoRedo.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore, type AssemblyUndoEntry } from '@/stores/assemblyStore'
import { registerCommand, clearAllHandlers } from '@/utils/core/commandRegistry'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderToolbar() {
  return render(
    <AssemblyToolbar
      docName="TestDoc"
      onRename={vi.fn()}
      handleSave={vi.fn()}
      handleClone={vi.fn()}
    />,
  )
}

function entry(label: string): AssemblyUndoEntry {
  return { doc: { kind: 'assembly', features: [] }, label: label as AssemblyUndoLabel }
}

const undoButton = () => screen.getByRole('button', { name: 'Undo' })
const redoButton = () => screen.getByRole('button', { name: 'Redo' })

// The real registry, wired to real stack moves: clicking a toolbar button has
// to reach a handler and shift the store's history, not just call a spy.
function stepHistory(direction: 'undo' | 'redo') {
  const { undoStack, redoStack } = useAssemblyStore.getState()
  const from = direction === 'undo' ? undoStack : redoStack
  if (from.length === 0) return
  const entry = from[from.length - 1]
  useAssemblyStore.setState(
    direction === 'undo'
      ? { undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, entry] }
      : { undoStack: [...undoStack, entry], redoStack: redoStack.slice(0, -1) },
  )
}

describe('AssemblyToolbar undo/redo', () => {
  beforeEach(() => {
    clearAllHandlers()
    registerCommand('undo', () => stepHistory('undo'))
    registerCommand('redo', () => stepHistory('redo'))
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
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
    useAssemblyStore.setState({ undoStack: [entry('Add part')], redoStack: [entry('Move part')] })
    renderToolbar()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(false)
    expect((redoButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('clicking undo routes through the registry and moves the entry onto redo', () => {
    useAssemblyStore.setState({ undoStack: [entry('Add part')], redoStack: [] })
    renderToolbar()
    fireEvent.click(undoButton())
    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(1)
  })

  it('clicking redo routes through the registry and moves the entry onto undo', () => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [entry('Move part')] })
    renderToolbar()
    fireEvent.click(redoButton())
    expect(useAssemblyStore.getState().undoStack).toHaveLength(1)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
  })

  it('the undo tooltip shows the up-to-five most recent actions, most recent first', () => {
    const stacks = Array.from({ length: 10 }, (_, i) => entry(`op ${i}`))
    useAssemblyStore.setState({ undoStack: stacks, redoStack: [] })
    renderToolbar()

    fireEvent.mouseEnter(undoButton())

    expect(screen.getByText('Undo (10) Ctrl+Z')).toBeTruthy()
    // Production logic: undoStack.slice(-5).reverse() -> op 9 first, op 5 last.
    expect(screen.getByText('op 9')).toBeTruthy()
    expect(screen.getByText('op 8')).toBeTruthy()
    expect(screen.getByText('op 7')).toBeTruthy()
    expect(screen.getByText('op 6')).toBeTruthy()
    expect(screen.getByText('op 5')).toBeTruthy()
    expect(screen.queryByText('op 4')).toBeNull()
  })

  it('the redo tooltip shows the redo stack and the undo one does not leak into it', () => {
    useAssemblyStore.setState({
      undoStack: [entry('undone')],
      redoStack: [entry('redone')],
    })
    renderToolbar()

    fireEvent.mouseEnter(redoButton())

    expect(screen.getByText('Redo (1) Ctrl+Shift+Z')).toBeTruthy()
    expect(screen.getByText('redone')).toBeTruthy()
    expect(screen.queryByText('undone')).toBeNull()
  })

  it('an empty stack shows no tooltip on hover', () => {
    renderToolbar()
    fireEvent.mouseEnter(undoButton())
    expect(screen.queryByText(/Ctrl\+Z/)).toBeNull()
  })
})
