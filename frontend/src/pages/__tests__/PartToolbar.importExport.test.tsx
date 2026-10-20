// The part's STEP import and export are document-level file actions, so they
// sit in the header's document group after Clone, behind the sine divider.
// They are direct page callbacks rather than registry commands: an open edit is
// the only gate, and it is read through useEditorState so closing the editor
// re-enables them without a remount.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import PartToolbar from '@/pages/PartToolbar'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext'
import { partRegistry } from './commandFixtures'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children, hasFileActions }: { children: React.ReactNode; hasFileActions?: boolean }) =>
    <div data-testid="header" data-has-file-actions={String(hasFileActions ?? false)}>{children}</div>,
}))

function renderToolbar() {
  const onImport = vi.fn()
  const onExport = vi.fn()
  render(
    <CommandRegistryProvider value={partRegistry()}>
      <PartToolbar
        docName="Bracket"
        onRename={vi.fn()}
        handleSave={vi.fn()}
        handleClone={vi.fn()}
        onImport={onImport}
        onExport={onExport}
      />
    </CommandRegistryProvider>,
  )
  return { onImport, onExport }
}

const importButton = () => screen.getByRole('button', { name: 'Import STEP' }) as HTMLButtonElement
const exportButton = () => screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement
const cloneButton = () => screen.getByRole('button', { name: 'Clone document' })

describe('PartToolbar file actions', () => {
  beforeEach(() => {
    act(() => {
      usePartEditorStore.setState({ undoStack: [], redoStack: [] })
      useEditorState.setState({ editingFeatureId: null })
      useEditorModeStore.getState().setActiveEditor('part')
    })
  })

  afterEach(() => {
    act(() => { useEditorModeStore.getState().setActiveEditor(null) })
  })

  it('renders Import STEP and Export after Clone, separated by the header divider', () => {
    renderToolbar()

    const separator = document.querySelector('.app-header-separator') as HTMLElement
    expect(separator).not.toBeNull()
    expect(screen.getByTestId('header')).toHaveAttribute('data-has-file-actions', 'true')
    expect(cloneButton().compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator.compareDocumentPosition(importButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(importButton().compareDocumentPosition(exportButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The header group keeps the clone before the file actions.
    expect(screen.getByTestId('header').contains(importButton())).toBe(true)
  })

  it('exposes the import and export dom handles', () => {
    renderToolbar()
    expect(importButton()).toHaveAttribute('data-oversolved-handle', 'toolbar:import_step')
    expect(exportButton()).toHaveAttribute('data-oversolved-handle', 'toolbar:export')
  })

  it('runs both file actions in normal mode', () => {
    const { onImport, onExport } = renderToolbar()
    fireEvent.click(importButton())
    fireEvent.click(exportButton())
    expect(onImport).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('disables both while a feature edit is open and does not run either action', () => {
    const { onImport, onExport } = renderToolbar()
    act(() => { useEditorState.setState({ editingFeatureId: 'ex1' }) })

    expect(importButton()).toBeDisabled()
    expect(exportButton()).toBeDisabled()
    expect(importButton()).toHaveAttribute('title', 'Finish the edit to import')
    expect(exportButton()).toHaveAttribute('title', 'Finish the edit to export')

    fireEvent.click(importButton())
    fireEvent.click(exportButton())
    expect(onImport).not.toHaveBeenCalled()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('disables both while a sketch edit is open too', () => {
    renderToolbar()
    act(() => { useEditorState.setState({ editingFeatureId: 'sk1' }) })

    expect(importButton()).toBeDisabled()
    expect(exportButton()).toBeDisabled()
  })

  it('re-enables the pair when the edit closes, without a remount', () => {
    renderToolbar()
    act(() => { useEditorState.setState({ editingFeatureId: 'ex1' }) })
    expect(importButton()).toBeDisabled()

    act(() => { useEditorState.setState({ editingFeatureId: null }) })

    expect(importButton()).toBeEnabled()
    expect(exportButton()).toBeEnabled()
    expect(importButton()).toHaveAttribute('title', 'Import STEP')
    expect(exportButton()).toHaveAttribute('title', 'Export')
  })

  // The file actions are page-bound callbacks, not executeCommand calls, so
  // unlike undo/redo they keep acting on this page's part in a co-mounted
  // split view. The active editor gate does not apply to them.
  it('stays enabled while the assembly editor owns the document', () => {
    useEditorModeStore.getState().setActiveEditor('assembly')
    const { onImport, onExport } = renderToolbar()

    expect(importButton()).toBeEnabled()
    expect(exportButton()).toBeEnabled()
    fireEvent.click(importButton())
    fireEvent.click(exportButton())
    expect(onImport).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()
  })
})
