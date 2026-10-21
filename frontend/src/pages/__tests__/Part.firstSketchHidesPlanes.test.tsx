// Page-level rule: "when the user inserted his first sketch, auto hide all the
// planes." A sketch is inserted once it has its plane, not when the feature
// row lands, because the plane pick needs the planes on screen. These tests
// drive both creation paths and check the one id set the page hands the
// viewport (the store's visibleFeatures), with the viewport mocked out.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: React.forwardRef(function MockViewport(
      props: { onRightClick?: (pos: [number, number]) => void },
      ref: React.Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        autoZoomToFit: vi.fn(),
        alignCameraToPlane: vi.fn(),
        alignCameraToFace: vi.fn(),
        captureScreenshotForSaving: vi.fn(),
      }))
      return <button data-testid="viewport-ctx" onClick={() => props.onRightClick?.([0, 0])} />
    }),
  }
})

vi.mock('@/components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())

const shown = (id: string) => usePartEditorStore.getState().visibleFeatures.has(id)
const feature = (id: string) => usePartEditorStore.getState().features.find(f => f.id === id)
const sketchPlane = (id: string) => {
  const found = feature(id)
  return found?.kind === 'sketch' ? found.plane : undefined
}
const planesHidden = () => ['Top', 'Front', 'Right'].every(id => feature(id)?.visible === false)

const HIDDEN_PLANES_DOC = `version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
    visible: false
  - id: Front
    kind: plane
    visible: false
  - id: Right
    kind: plane
    visible: false
  - id: sk1
    kind: sketch
    plane: '@builtin_plane_front'
`

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

const menuItem = (name: string) => {
  const button = screen.getAllByRole('button', { name }).find(b => b.closest('[data-testid="context-menu"]'))
  expect(button).toBeDefined()
  return button!
}

describe('Part - the first sketch hides the planes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorState.setState({
      normalSelection: new Set(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      hoveredSelectionId: null,
    })
  })

  it('Sketch button then picking Front hides the planes while the sketch edit opens', async () => {
    partDocStoreMock()
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await act(async () => { fireEvent.click(screen.getByTitle('Sketch')) })
    const sketchId = await waitFor(() => {
      const id = useEditorState.getState().editingFeatureId
      expect(id).not.toBeNull()
      return id!
    })

    // With the plane field armed the planes are drawn: this is the strip the
    // user picks from, and the last moment they are needed.
    await waitFor(() => expect(shown('Front')).toBe(true))

    act(() => { useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_front', 'pick') })

    await waitFor(() => expect(sketchPlane(sketchId)).toBe('@builtin_plane_front'))
    await waitFor(() => expect(shown('Front')).toBe(false))
    expect(planesHidden()).toBe(true)
    expect(useEditorState.getState().editingFeatureId).toBe(sketchId)
  })

  it('the context menu New Sketch on Front hides the planes too', async () => {
    partDocStoreMock()
    renderPart()
    await screen.findByTitle('Feature mode')

    // A viewport right-click with Front under the pointer, the real driver of
    // the pre-bound add_sketch path.
    useSketchEditorStore.setState({ hoveredSelectionId: '@builtin_plane_front' })
    await act(async () => { fireEvent.click(screen.getByTestId('viewport-ctx')) })
    await act(async () => { fireEvent.click(menuItem('New Sketch')) })

    const sketchId = await waitFor(() => {
      const id = useEditorState.getState().editingFeatureId
      expect(id).not.toBeNull()
      return id!
    })
    await waitFor(() => expect(sketchPlane(sketchId)).toBe('@builtin_plane_front'))
    await waitFor(() => expect(planesHidden()).toBe(true))
    expect(shown('Front')).toBe(false)
  })

  it('a new sketch can still pick a built-in plane while the planes are hidden', async () => {
    partDocStoreMock({ content: HIDDEN_PLANES_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    await waitFor(() => expect(shown('sk1')).toBe(true))
    expect(shown('Front')).toBe(false)

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Sketch')) })

    // The armed field derives the planes back on screen. Without this a hidden
    // plane would not be drawn, so it could not be picked at all.
    await waitFor(() => expect(shown('Front')).toBe(true))

    act(() => { useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top', 'pick') })

    await waitFor(() => {
      const second = usePartEditorStore.getState().features.find(f => f.kind === 'sketch' && f.id !== 'sk1')
      expect(second?.kind === 'sketch' ? second.plane : undefined).toBe('@builtin_plane_top')
    })
    await waitFor(() => expect(shown('Front')).toBe(false))
    expect(feature('Top')?.visible).toBe(false)
  })
})
