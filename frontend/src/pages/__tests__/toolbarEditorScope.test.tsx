// dispatchKey gates every key on useEditorModeStore, but a toolbar button click
// goes straight to executeCommand with no such gate. Today it cannot leak
// because WorkspacePage mounts exactly one keyed editor; if both ever co-mount
// (split view, staged navigation) the click would run whichever engine registered
// `undo` last while the button's disabled state read the other store. Each
// toolbar therefore stands down unless it owns the active editor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import PartToolbar from '@/pages/PartToolbar'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useAssemblyStore, type AssemblyUndoEntry } from '@/stores/assemblyStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { registerCommand, clearAllHandlers } from '@/utils/core/commandRegistry'
import type { Mutation } from '@/types/cad'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderPart() {
  return render(
    <PartToolbar docName="Doc" onRename={vi.fn()} handleSave={vi.fn()} handleClone={vi.fn()} />,
  )
}

function renderAssembly() {
  return render(
    <AssemblyToolbar docName="Doc" onRename={vi.fn()} handleSave={vi.fn()} handleClone={vi.fn()} />,
  )
}

// Both stacks are seeded so the buttons are enabled: a disabled button would
// swallow the click and the gate would never be exercised.
const partEntry = { doc: { version: 1, kind: 'part' }, mutation: { type: 'rename_feature', featureId: 'f1', label: 'a' } as Mutation }

const assemblyEntry: AssemblyUndoEntry = {
  doc: { kind: 'assembly', features: [] },
  label: 'Add part' as AssemblyUndoEntry['label'],
}

const undoButton = () => screen.getByRole('button', { name: 'Undo' })
const redoButton = () => screen.getByRole('button', { name: 'Redo' })

describe('toolbar undo/redo editor scope', () => {
  beforeEach(() => {
    clearAllHandlers()
    usePartEditorStore.setState({ undoStack: [partEntry], redoStack: [partEntry] })
    useAssemblyStore.setState({ undoStack: [assemblyEntry], redoStack: [assemblyEntry] })
  })

  afterEach(() => {
    clearAllHandlers()
    useEditorModeStore.getState().setActiveEditor(null)
  })

  it('the part toolbar runs undo and redo while the part editor owns the document', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    useEditorModeStore.getState().setActiveEditor('part')

    renderPart()
    fireEvent.click(undoButton())
    fireEvent.click(redoButton())

    expect(undo).toHaveBeenCalledOnce()
    expect(redo).toHaveBeenCalledOnce()
  })

  it('the part toolbar stands down while the assembly editor owns the document', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    useEditorModeStore.getState().setActiveEditor('assembly')

    renderPart()
    fireEvent.click(undoButton())
    fireEvent.click(redoButton())

    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })

  it('the part toolbar disables the pair while another editor owns the document', () => {
    // The disabled state reads the part store, so without the gate on the
    // derivation it would advertise an undo that then refuses to run.
    useEditorModeStore.getState().setActiveEditor('assembly')
    renderPart()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(true)
    expect((redoButton() as HTMLButtonElement).disabled).toBe(true)
  })

  // The gate exists for the moment the mode CHANGES (a co-mounted pair taking
  // over). Sampled at render time it would not re-run, so the button would keep
  // advertising an undo it refuses to run until something else re-rendered it.
  it('the part toolbar re-evaluates its gate when the active editor changes after mount', () => {
    useEditorModeStore.getState().setActiveEditor('part')
    renderPart()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(false)

    act(() => { useEditorModeStore.getState().setActiveEditor('assembly') })

    expect((undoButton() as HTMLButtonElement).disabled).toBe(true)

    act(() => { useEditorModeStore.getState().setActiveEditor('part') })

    expect((undoButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('the assembly toolbar runs undo and redo while the assembly editor owns the document', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    useEditorModeStore.getState().setActiveEditor('assembly')

    renderAssembly()
    fireEvent.click(undoButton())
    fireEvent.click(redoButton())

    expect(undo).toHaveBeenCalledOnce()
    expect(redo).toHaveBeenCalledOnce()
  })

  it('the assembly toolbar stands down while the part editor owns the document', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    registerCommand('undo', undo)
    registerCommand('redo', redo)
    useEditorModeStore.getState().setActiveEditor('part')

    renderAssembly()
    fireEvent.click(undoButton())
    fireEvent.click(redoButton())

    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })

  it('the assembly toolbar disables the pair while another editor owns the document', () => {
    useEditorModeStore.getState().setActiveEditor('part')
    renderAssembly()
    expect((undoButton() as HTMLButtonElement).disabled).toBe(true)
    expect((redoButton() as HTMLButtonElement).disabled).toBe(true)
  })
})
