// The undo/redo buttons and tooltips against the PRODUCTION AssemblyToolbar.
// The stacks are seeded straight into assemblyStore (the page's mutate pushes
// into it; the hook that drives it is covered in useAssemblyUndoRedo.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore, type AssemblyUndoEntry } from '@/stores/assemblyStore'

const mockExecuteCommand = vi.hoisted(() => vi.fn())

vi.mock('@/utils/core/commandRegistry', () => ({ executeCommand: mockExecuteCommand }))
vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderToolbar() {
  return render(
    <AssemblyToolbar
      readOnly={false}
      docName="TestDoc"
      onRename={vi.fn()}
      handleSave={vi.fn()}
      handleClone={vi.fn()}
    />,
  )
}

function entry(label: string): AssemblyUndoEntry {
  return { doc: { kind: 'assembly', features: [] }, label }
}

const undoButton = () => screen.getByRole('button', { name: 'Undo' })
const redoButton = () => screen.getByRole('button', { name: 'Redo' })

describe('AssemblyToolbar undo/redo', () => {
  beforeEach(() => {
    mockExecuteCommand.mockClear()
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
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

  it('clicking the buttons dispatches the undo and redo commands', () => {
    useAssemblyStore.setState({ undoStack: [entry('Add part')], redoStack: [entry('Move part')] })
    renderToolbar()
    fireEvent.click(undoButton())
    fireEvent.click(redoButton())
    expect(mockExecuteCommand).toHaveBeenCalledWith('undo')
    expect(mockExecuteCommand).toHaveBeenCalledWith('redo')
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
