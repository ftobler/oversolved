import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
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
vi.mock('../../components/AppHeader', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../../components/FooterMeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/BugReporter', () => ({ BugReporter: () => null }))
vi.mock('../../components/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/ShareDialog', () => ({ default: () => null }))
vi.mock('../../components/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/WsReconnect', () => ({ default: () => null }))

interface MenuItem {
  label: string
  onClick: () => void
}

vi.mock('../../components/RightClickMenu', () => ({
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

vi.mock('../../components/Sidebar', async () => {
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

describe('Part Color Preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      dynamicSelection: new Set(),
      hoveredEntityId: null,
      hoveredVertexId: null,
      hoveredPlaneId: null,
      hoveredSurfaceId: null,
      hovered3DSurfaceId: null,
      activeTool: null,
      planeSelectionFeatureId: null,
      pendingPickField: null,
      showDebugHit: false,
    })
  })

  function renderPart() {
    return render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('opens color popover from context menu', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))

    expect(screen.getByTestId('context-menu')).toBeInTheDocument()
  })

  it('starts preview mode when color popover opens', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    expect(mockStartPreviewMode).toHaveBeenCalled()
  })

  it('calls cancelPreview when cancel button is clicked', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    const cancelBtn = screen.getByText('Cancel')
    fireEvent.click(cancelBtn)

    expect(mockCancelPreview).toHaveBeenCalled()
  })

  it('calls commitPreview when apply button is clicked', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    const applyBtn = screen.getByText('Apply')
    fireEvent.click(applyBtn)

    expect(mockCommitPreview).toHaveBeenCalled()
  })
})
