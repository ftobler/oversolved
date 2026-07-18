import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'

const mockStartPreviewMode = vi.fn()
const mockCommitPreview = vi.fn()
const mockCancelPreview = vi.fn()
const mockHandleMutation = vi.fn()
const mockReSolve = vi.fn()
const mockSetDoc = vi.fn()

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
      doc: {
        version: 1,
        kind: 'part',
        features: [],
        part_style: {
          'body-1': { name: 'Test Body', color: '#FF0000', transparency: 0, metalness: 0.3 },
        },
      },
      setDoc: mockSetDoc,
      docRef: { current: { version: 1, kind: 'part', features: [], part_style: {} } },
      loading: false,
      error: null,
      setError: vi.fn(),
      solveResults: {},
      bodies: { 'body-1': { id: 'body-1', created_by: 'feature-1', modified_by: [] } },
      pickBodies: {},
      solving: false,
      solveTime: null,
      solveError: null,
      setSolveError: vi.fn(),
      solveResult: '',
      undoStack: [],
      redoStack: [],
      reSolve: mockReSolve,
      handleMutation: mockHandleMutation,
      handleUndo: vi.fn(),
      handleRedo: vi.fn(),
      saveDoc: vi.fn(),
      renameDoc: vi.fn(),
      docName: 'Test Doc',
      ownerUsername: 'user',
      permission: 'owner',
      setPickBoundary: vi.fn(),
      setRollbackPos: vi.fn(),
      startPreviewMode: mockStartPreviewMode,
      commitPreview: mockCommitPreview,
      cancelPreview: mockCancelPreview,
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

interface MenuItem {
  label: string
  onClick: () => void
}

vi.mock('../../components/dialogs/RightClickMenu', () => ({
  default: vi.fn(({ items }: { items: MenuItem[] }) => (
    <div data-testid="context-menu">
      {items.map((item: MenuItem, i: number) => (
        <button key={i} data-testid={`menu-item-${i}`} onClick={() => item.onClick()}>
          {item.label}
        </button>
      ))}
    </div>
  )),
}))

vi.mock('../../components/layout/Sidebar', async () => {
  const { usePartEditorStore } = await import('@/stores/partEditorStore')
  const { usePartEditorCallbacks } = await import('@/contexts/PartEditorContext')
  return {
    Sidebar: vi.fn(() => {
      const bodies = usePartEditorStore(s => s.bodies)
      const { onRightClick } = usePartEditorCallbacks()
      return (
        <div data-testid="sidebar">
          {Object.keys(bodies || {}).map((bodyId: string) => (
            <div key={bodyId} data-testid={`body-${bodyId}`}>
              <button
                data-testid={`context-btn-${bodyId}`}
                onClick={(e: React.MouseEvent) => onRightClick([e.clientX, e.clientY], `body:${bodyId}`)}
              >
                Context
              </button>
            </div>
          ))}
        </div>
      )
    }),
  }
})

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

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
      activePickField: null,
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
