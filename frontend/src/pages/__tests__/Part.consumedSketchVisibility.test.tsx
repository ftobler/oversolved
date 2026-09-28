// A sketch an extrude consumes is not drawn once the extrude exists. The page
// hands the viewport one id set (the store's visibleFeatures); these tests read
// it with the viewport mocked out, so the rule holds without a viewport.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { makeAncestryQuery } from '@/kernel/query'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

const area = (sk: string) => makeAncestryQuery([`@${sk}/c1`, 'surface:0', `@${sk}`], 'flatface')

const shown = (id: string) => usePartEditorStore.getState().visibleFeatures.has(id)

function renderPart(content: string) {
  partDocStoreMock({ content })
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

describe('Part - consumed sketch visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
    })
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
  })

  it('does not draw a sketch a loaded extrude consumes, even with no visible flag', async () => {
    // The regression: a document whose extrude never went through the
    // pick-time hide (saved while auto-hide was off) drew its profile sketch
    // on top of the body forever.
    renderPart(`version: 1
kind: part
features:
  - id: sk1
    kind: sketch
  - id: sk2
    kind: sketch
  - id: ex1
    kind: extrude
    extrude: { sketch: ['${area('sk1')}'], distance: 10 }
`)
    await screen.findByTitle('Feature mode')
    await waitFor(() => expect(shown('sk2')).toBe(true))
    expect(shown('sk1')).toBe(false)
  })

  it('an inserted extrude shows its profile sketch while open and hides it on OK', async () => {
    renderPart(`version: 1
kind: part
features:
  - id: sk1
    kind: sketch
`)
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))
    await waitFor(() => expect(shown('sk1')).toBe(true))

    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(screen.getByTitle('OK')).toBeInTheDocument())
    const q = area('sk1')
    act(() => { useSketchEditorStore.getState().toggleNormalSelection(q, 'pick') })
    await waitFor(() => {
      const ex = usePartEditorStore.getState().features.find(f => f.kind === 'extrude')
      expect(ex?.extrude?.sketch).toEqual([q])
    })
    // The open editor keeps its own profile on screen as the selection.
    expect(shown('sk1')).toBe(true)

    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBeNull())
    expect(shown('sk1')).toBe(false)
  })

  it('an extrude inserted off a body face does not bring back the sketch behind that body', async () => {
    // The user-visible bug: every face of an extruded body carries its sketch's
    // edges in its query ancestry, so a second extrude picking such a face
    // counted the first body's (long hidden) sketch as its own profile and the
    // open editor drew it again.
    renderPart(`version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    visible: false
    auto_hidden: true
  - id: ex1
    kind: extrude
    extrude: { sketch: ['${area('sk1')}'], distance: 10 }
`)
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))
    await waitFor(() => expect(shown('ex1')).toBe(true))
    expect(shown('sk1')).toBe(false)

    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(screen.getByTitle('OK')).toBeInTheDocument())
    const face = makeAncestryQuery(['@u|u_0a3cb58fde38f980', '@ex1', '@body_ex1', '@sk1/left', '@cls_xn'], 'flatface')
    act(() => { useSketchEditorStore.getState().toggleNormalSelection(face, 'pick') })
    await waitFor(() => {
      const ex = usePartEditorStore.getState().features.find(f => f.kind === 'extrude' && f.id !== 'ex1')
      expect(ex?.extrude?.sketch).toEqual([face])
    })
    expect(shown('sk1')).toBe(false)
  })
})
