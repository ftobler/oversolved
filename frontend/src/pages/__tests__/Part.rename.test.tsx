import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

// `vi.hoisted`, because the usePartDoc factory below is hoisted above this line
// and reads the spy while building the module.
const mockHandleMutation = vi.hoisted(() => vi.fn())

const STYLED_DOC = vi.hoisted(() => ({
  version: 1,
  kind: 'part',
  features: [],
  part_style: {
    'body-1': { name: 'Test Body', color: '#FF0000', transparency: 0, metalness: 0.3 },
  },
}))
const BODIES = vi.hoisted(() => ({ 'body-1': { id: 'body-1', created_by: 'feature-1', modified_by: [] } }))

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    doc: STYLED_DOC,
    bodies: BODIES,
    handleMutation: mockHandleMutation,
  }))

vi.mock('../../contexts/AuthContext', async () =>
  (await import('@/__tests__/test-utils')).authMockModule())

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../../components/layout/FooterMeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ShareDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))

vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())

vi.mock('../../components/layout/Sidebar', async () =>
  (await import('@/__tests__/test-utils')).sidebarMockModule())

// The context menu only names the rename target; these cover the rest of the
// path, from the menu item through the dialog to the mutation.
describe('Part rename dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      activeTool: null,
      activePickField: null, modeStack: [],
      showDebugHit: false,
    })
  })

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

  function openRename() {
    renderPart()
    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByTestId('menu-item-0'))
  }

  // The mocked context menu keeps its own 'Rename' item mounted, so the footer
  // buttons have to be reached through the dialog box.
  function dialogButton(name: string) {
    const box = document.querySelector('.dialog-component') as HTMLElement
    return within(box).getByRole('button', { name })
  }

  it('opens seeded with the body label instead of a window prompt', () => {
    const promptSpy = vi.spyOn(window, 'prompt')
    openRename()
    expect(screen.getByRole('textbox')).toHaveValue('Test Body')
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('routes a confirmed body rename to the rename_part mutation', () => {
    openRename()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bracket' } })
    fireEvent.click(dialogButton('Rename'))
    expect(mockHandleMutation).toHaveBeenCalledWith({
      type: 'rename_part',
      bodyId: 'body-1',
      name: 'Bracket',
    })
  })

  it('mutates nothing when the rename is cancelled', () => {
    openRename()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bracket' } })
    fireEvent.click(dialogButton('Cancel'))
    expect(mockHandleMutation).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('closes after a confirmed rename', () => {
    openRename()
    fireEvent.click(dialogButton('Rename'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
