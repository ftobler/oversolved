import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

// `vi.hoisted`, because the usePartDoc factory below is hoisted above this line
// and reads the spies while building the module.
const mockStartPreviewMode = vi.hoisted(() => vi.fn())
const mockCommitPreview = vi.hoisted(() => vi.fn())
const mockCancelPreview = vi.hoisted(() => vi.fn())

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
    startPreviewMode: mockStartPreviewMode,
    commitPreview: mockCommitPreview,
    cancelPreview: mockCancelPreview,
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

describe('Part Color Preview', () => {
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

  it('calls cancelPreview exactly once when cancel button is clicked twice', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    const cancelBtn = screen.getByText('Cancel')
    fireEvent.click(cancelBtn)
    fireEvent.click(cancelBtn)

    expect(mockCancelPreview).toHaveBeenCalledTimes(1)
  })

  it('calls commitPreview when apply button is clicked', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    const applyBtn = screen.getByText('Apply')
    fireEvent.click(applyBtn)

    expect(mockCommitPreview).toHaveBeenCalled()
  })

  // The popover once carried its own button copy, which drifted out of step with
  // the app-wide `.btn` system the dialogs use.
  it('uses the shared button classes for its actions', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    expect(screen.getByText('Apply').className).toBe('btn btn-primary')
    expect(screen.getByText('Cancel').className).toBe('btn btn-secondary')
  })

  it('renders a header icon', async () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))

    expect(screen.getByText('palette')).toBeInTheDocument()
  })
})
