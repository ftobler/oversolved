// Closing the color popover through `onSetPartColorPopover(null)` (or, the same
// branch, opening it while no document is loaded) used to only drop the popover
// state. The open had put usePartDoc into preview mode and nothing took it out
// again, so the preview stayed live behind a closed popover: the abandoned
// color was never rewound, further color edits were swallowed with no undo
// entry, and the next unrelated edit escape-committed the abandoned preview as
// a second entry beside its own.
//
// This suite runs the REAL usePartDoc under the page, stubbing only its
// document and solver seams, because the bug lives between the page's popover
// state and the hook's preview state and a mocked hook cannot show it.
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import type { BuildContextMenuCallbacks } from '@/pages/buildContextMenu'
import type { PartDoc } from '@/types/cad'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
  part_style: { 'body-1': { name: 'Test Body', color: '#ff0000' } },
} as unknown as PartDoc)

const docRef = vi.hoisted(() => ({ current: null as PartDoc | null }))
const reSolve = vi.hoisted(() => vi.fn())
// The callbacks object the page hands to buildContextMenu, so a test can fire
// the close path exactly as a future call site would.
const menuCallbacks = vi.hoisted(() => ({ current: null as BuildContextMenuCallbacks | null }))

vi.mock('@/hooks/useDocumentState', async () => {
  const { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } = await import('@/utils/builtins')
  const react = await import('react')
  return {
    BUILTIN_FEATURE_DEFAULTS,
    BUILTIN_FEATURE_IDS,
    // A real useState behind setDoc, so the doc rewind a cancelled preview
    // performs re-renders the page the way the production hook does.
    useDocumentState: () => {
      const [doc, setDocState] = react.useState(() => docRef.current)
      const setDoc = react.useCallback((d: PartDoc) => {
        docRef.current = d
        setDocState(d)
      }, [])
      return {
        doc, setDoc, docRef, docName: 'test', setDocName: vi.fn(),
        ownerUsername: null, loading: false, error: null, setError: vi.fn(),
        saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
      }
    },
  }
})

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(),
    bodies: { 'body-1': { id: 'body-1', created_by: 'extrude-1', modified_by: [] } },
    pickBodies: {}, pickStateReady: true,
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve, validation: null,
  }),
}))

vi.mock('@/pages/buildContextMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/buildContextMenu')>()
  return {
    ...actual,
    buildContextMenu: (
      input: Parameters<typeof actual.buildContextMenu>[0],
      callbacks: BuildContextMenuCallbacks,
    ) => {
      menuCallbacks.current = callbacks
      return actual.buildContextMenu(input, callbacks)
    },
  }
})

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div>{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))

vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())

// A sidebar stand-in with the page callbacks this suite drives: the body
// context menu (which opens the popover), the live color edit the popover's
// swatches make, and an ordinary mutation unrelated to the preview.
vi.mock('../../components/layout/Sidebar', () => ({
  Sidebar: () => {
    const { onRightClick, onMutation } = usePartEditorCallbacks()
    return (
      <div>
        <button
          data-testid="context-btn-body-1"
          onClick={(e) => onRightClick([e.clientX, e.clientY], 'body:body-1')}
        >menu</button>
        <button
          data-testid="preview-color"
          onClick={() => onMutation({ type: 'set_part_color', bodyId: 'body-1', color: '#00ff00' })}
        >color</button>
        <button
          data-testid="rename-feature"
          onClick={() => onMutation({ type: 'rename_feature', featureId: 'extrude-1', label: 'second' })}
        >rename</button>
      </div>
    )
  },
}))

const colorOf = () => (docRef.current?.part_style?.['body-1'] as { color?: string } | undefined)?.color
const labelOf = () => (docRef.current?.features?.[0] as { label?: string } | undefined)?.label
const undoStack = () => usePartEditorStore.getState().undoStack

function contextCallbacks(): BuildContextMenuCallbacks {
  if (!menuCallbacks.current) throw new Error('context menu was never built')
  return menuCallbacks.current
}

describe('Part color popover close path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docRef.current = makeDoc()
    menuCallbacks.current = null
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

  it('closing with a null payload resolves the preview instead of stranding undo suppression', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))
    fireEvent.click(screen.getByText('Color'))
    expect(screen.getByText('Apply')).toBeInTheDocument()

    // The popover's live edit: swallowed by the preview, no undo entry yet.
    fireEvent.click(screen.getByTestId('preview-color'))
    expect(colorOf()).toBe('#00ff00')
    expect(undoStack()).toHaveLength(0)

    act(() => { contextCallbacks().onSetPartColorPopover(null) })

    expect(screen.queryByText('Apply')).toBeNull()
    // Cancelled, not committed: the previewed color must not survive the close.
    expect(colorOf()).toBe('#ff0000')
    expect(undoStack()).toHaveLength(0)

    // The point of the fix: ordinary editing still records undo afterwards.
    fireEvent.click(screen.getByTestId('rename-feature'))
    expect(labelOf()).toBe('second')
    expect(undoStack()).toHaveLength(1)
    const undoneDoc = undoStack()[0].doc as PartDoc
    expect((undoneDoc.features?.[0] as { label?: string }).label).toBe('first')
  })

  // The close path is also reached with a truthy payload when no document is
  // loaded, where no preview can start. Nothing to resolve, nothing to break.
  it('a close with nothing open leaves the undo funnel alone', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('context-btn-body-1'))  // builds the menu, opens no popover
    act(() => { contextCallbacks().onSetPartColorPopover(null) })

    fireEvent.click(screen.getByTestId('rename-feature'))
    expect(undoStack()).toHaveLength(1)
  })
})
