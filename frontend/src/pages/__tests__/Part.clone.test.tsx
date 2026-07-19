import React from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'

const mockCloneDoc = vi.fn(async () => ({ uuid: 'clone-uuid' }))

vi.mock('../../hooks/usePartDoc', () => {
  const _builtinDefaults = [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'Front', kind: 'plane' },
    { id: 'Right', kind: 'plane' },
  ]
  return {
    BUILTIN_FEATURE_DEFAULTS: _builtinDefaults,
    BUILTIN_FEATURE_IDS: new Set(_builtinDefaults.map(f => f.id)),
    usePartDoc: () => ({
      doc: { version: 1, kind: 'part', features: [], part_style: {} },
      setDoc: vi.fn(),
      docRef: { current: { version: 1, kind: 'part', features: [], part_style: {} } },
      loading: false,
      error: null,
      setError: vi.fn(),
      solveResults: {},
      bodies: {},
      pickBodies: {},
      solving: false,
      solveTime: null,
      solveError: null,
      setSolveError: vi.fn(),
      solveResult: '',
      undoStack: [],
      redoStack: [],
      reSolve: vi.fn(),
      handleMutation: vi.fn(),
      handleUndo: vi.fn(),
      handleRedo: vi.fn(),
      saveDoc: vi.fn(),
      renameDoc: vi.fn(),
      cloneDoc: mockCloneDoc,
      docName: 'Bracket',
      ownerUsername: 'user',
      permission: 'owner',
      setPickBoundary: vi.fn(),
      setRollbackPos: vi.fn(),
      startPreviewMode: vi.fn(),
      commitPreview: vi.fn(),
      cancelPreview: vi.fn(),
    }),
  }
})

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { is_admin: false },
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

vi.mock('../../components/Viewport', () => ({
  default: forwardRef(function MockViewport(_props: Record<string, unknown>, ref) {
    useImperativeHandle(ref, () => ({
      autoZoomToFit: vi.fn(),
      captureScreenshot: vi.fn(),
      captureScreenshotForSaving: vi.fn(),
      alignCameraToPlane: vi.fn(),
      alignCameraToFace: vi.fn(),
    }))
    return null
  }),
  __esModule: true,
}))

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../../components/layout/FooterMeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ShareDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/layout/Sidebar', () => ({ Sidebar: () => null }))

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

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
      activePickField: null,
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
