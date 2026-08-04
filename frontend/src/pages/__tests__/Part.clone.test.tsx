import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

// `vi.hoisted`, because the usePartDoc factory below is hoisted above this line
// and reads the spy while building the module.
const mockCloneDoc = vi.hoisted(() => vi.fn(async () => ({ uuid: 'clone-uuid' })))

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({ cloneDoc: mockCloneDoc, docName: 'Bracket' }))

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
vi.mock('../../components/layout/Sidebar', () => ({ Sidebar: () => null }))

// Cloning used to fire straight off the toolbar with a server-picked name. It
// now prompts, so these cover the whole path: button -> dialog -> clone call.
describe('Part clone dialog', () => {
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

  function openClone() {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clone document' }))
  }

  function dialogButton(name: string) {
    const box = document.querySelector('.dialog-component') as HTMLElement
    return within(box).getByRole('button', { name })
  }

  it('prompts with the suggested name instead of cloning immediately', () => {
    openClone()
    expect(screen.getByRole('textbox')).toHaveValue('Bracket (Clone)')
    expect(mockCloneDoc).not.toHaveBeenCalled()
  })

  it('clones under the confirmed name', async () => {
    openClone()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bracket v2' } })
    // The confirm navigates to the new document, so let that settle in act.
    await act(async () => { fireEvent.click(dialogButton('Clone')) })
    expect(mockCloneDoc).toHaveBeenCalledWith('doc-1', 'Bracket v2')
  })

  it('clones under the prefilled name when the prompt is confirmed unchanged', async () => {
    openClone()
    await act(async () => { fireEvent.click(dialogButton('Clone')) })
    expect(mockCloneDoc).toHaveBeenCalledWith('doc-1', 'Bracket (Clone)')
  })

  it('clones nothing when the prompt is cancelled', () => {
    openClone()
    fireEvent.click(dialogButton('Cancel'))
    expect(mockCloneDoc).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
