// The assembly's only file action is Export assembly. It sits in the header's
// document group after Clone, behind the sine divider, with no import button.
// An open mate or part (instance) editor greys it: that is the same
// editingSubject closeOpenEditor acts on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext'
import { assemblyRegistry, storeBackedAssemblyContext } from './commandFixtures'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children, hasFileActions }: { children: React.ReactNode; hasFileActions?: boolean }) =>
    <div data-testid="header" data-has-file-actions={String(hasFileActions ?? false)}>{children}</div>,
}))

function renderToolbar() {
  const onExport = vi.fn()
  render(
    <CommandRegistryProvider value={assemblyRegistry(storeBackedAssemblyContext())}>
      <AssemblyToolbar
        docName="Assembly"
        onRename={vi.fn()}
        handleSave={vi.fn()}
        handleClone={vi.fn()}
        onExport={onExport}
      />
    </CommandRegistryProvider>,
  )
  return { onExport }
}

const exportButton = () => screen.getByRole('button', { name: 'Export assembly' }) as HTMLButtonElement
const cloneButton = () => screen.getByRole('button', { name: 'Clone document' })

describe('AssemblyToolbar file actions', () => {
  beforeEach(() => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [], editingSubject: { kind: 'none' } })
    act(() => { useEditorModeStore.getState().setActiveEditor('assembly') })
  })

  afterEach(() => {
    // RTL cleanup runs in its own afterEach; this one can still see the mounted
    // toolbar, so the store writes have to be act-wrapped too.
    act(() => {
      useEditorModeStore.getState().setActiveEditor(null)
      useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
    })
  })

  it('renders Export assembly after Clone behind the divider, with no import', () => {
    renderToolbar()

    const separator = document.querySelector('.app-header-separator') as HTMLElement
    expect(separator).not.toBeNull()
    expect(screen.getByTestId('header')).toHaveAttribute('data-has-file-actions', 'true')
    expect(cloneButton().compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator.compareDocumentPosition(exportButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Import STEP' })).toBeNull()
  })

  it('runs the export from the header', () => {
    const { onExport } = renderToolbar()
    fireEvent.click(exportButton())
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('disables export while a mate editor is open', () => {
    const { onExport } = renderToolbar()
    act(() => { useAssemblyStore.setState({ editingSubject: { kind: 'mate', id: 'm1' } }) })

    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAttribute('title', 'Finish the edit to export')
    fireEvent.click(exportButton())
    expect(onExport).not.toHaveBeenCalled()
  })

  it('disables export while a part editor is open', () => {
    renderToolbar()
    act(() => { useAssemblyStore.setState({ editingSubject: { kind: 'instance', handle: 'hA' } }) })

    expect(exportButton()).toBeDisabled()
  })

  it('re-enables export when the editor closes', () => {
    const { onExport } = renderToolbar()
    act(() => { useAssemblyStore.setState({ editingSubject: { kind: 'mate', id: 'm1' } }) })
    expect(exportButton()).toBeDisabled()

    act(() => { useAssemblyStore.getState().closeEditor() })

    expect(exportButton()).toBeEnabled()
    expect(exportButton()).toHaveAttribute('title', 'Export assembly')
    fireEvent.click(exportButton())
    expect(onExport).toHaveBeenCalledOnce()
  })

  // Export is a page-bound callback, so it acts on this assembly even while an
  // unresolved (headless-test) mode store has no editor to route through.
  it('does not take the undo/redo active-editor gate', () => {
    act(() => { useEditorModeStore.getState().setActiveEditor(null) })
    const { onExport } = renderToolbar()

    expect(exportButton()).toBeEnabled()
    fireEvent.click(exportButton())
    expect(onExport).toHaveBeenCalledOnce()
  })
})
