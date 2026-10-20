// Opening a document whose rollback bar is parked must never hand the
// rolled-back tail to the solver. The load seam used to solve before the page's
// rollback effect ran, so the editor store was still null ("bar at the end")
// and the first payload carried every feature, including the one the user had
// rolled back past.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { solveViaWorker } from '@/kernel/worker/solverClient'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn(),
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const solveMock = vi.mocked(solveViaWorker)

// Seven features so a bar at 6 parks exactly one row back. The trailing
// move_face stands in for the reported document's last feature: it must stay
// out of the payload (and in the real report, out of the kernel that hangs on
// it). The id prefix lets the swap test tell the two documents apart.
function sevenFeatureDoc(rollback: number | null, prefix = ''): string {
  const id = (n: number) => `${prefix}f${n}`
  return `version: 1
kind: part
${rollback === null ? '' : `rollback: ${rollback}\n`}features:
  - id: ${id(1)}
    kind: sketch
    label: ${prefix}sketch 1
  - id: ${id(2)}
    kind: extrude
    label: ${prefix}extrude 1
    extrude: { sketch: '$${id(1)}', distance: 10, direction: 'normal' }
  - id: ${id(3)}
    kind: sketch
    label: ${prefix}sketch 2
  - id: ${id(4)}
    kind: sketch
    label: ${prefix}sketch 3
  - id: ${id(5)}
    kind: sketch
    label: ${prefix}sketch 4
  - id: ${id(6)}
    kind: sketch
    label: ${prefix}sketch 5
  - id: ${id(7)}
    kind: move_face
    label: ${prefix}move face 1
    move_face:
      faces: []
      distance: 5
`
}

// The reported document has four built-ins before the user stack. rollback 6
// therefore includes the sketch and extrude and excludes the move_face.
const REPORT_DOC = `version: 1
kind: part
rollback: 6
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
  - id: sk1
    kind: sketch
    label: sketch 1
  - id: ex1
    kind: extrude
    label: extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: mf1
    kind: move_face
    label: move face 1
    move_face:
      faces: []
      distance: 5
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

function firstPayload() {
  expect(solveMock).toHaveBeenCalled()
  return solveMock.mock.calls[0][0] as {
    features: Array<{ id: string }>
    rollback_position: number
    is_preview: boolean
  }
}

function OpenDocButton({ id }: { id: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(`/documents/${id}`)}>open {id}</button>
}

describe('Part - opening a rolled-back document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorState.getState().resetEditorState()
    solveMock.mockResolvedValue({ result: {}, bodies: {}, _build_state: null } as never)
  })

  it('does not send the rolled-back feature in the first load solve', async () => {
    partDocStoreMock({ content: sevenFeatureDoc(6) })
    renderPart()

    await waitFor(() => expect(screen.getByText('move face 1')).toBeInTheDocument())
    await waitFor(() => expect(solveMock).toHaveBeenCalled())

    const payload = firstPayload()
    expect(payload.features.map(f => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'])
    expect(payload.rollback_position).toBe(6)
    expect(payload.is_preview).toBe(true)
  })

  it('matches the reported built-in layout: bar 6 sends only the two user features', async () => {
    partDocStoreMock({ content: REPORT_DOC })
    renderPart()

    await waitFor(() => expect(screen.getByText('move face 1')).toBeInTheDocument())
    await waitFor(() => expect(solveMock).toHaveBeenCalled())

    const payload = firstPayload()
    expect(payload.features.map(f => f.id)).toEqual(['sk1', 'ex1'])
    expect(payload.rollback_position).toBe(2)
    expect(payload.is_preview).toBe(true)
  })

  it('solves the whole stack when the document has no rollback key', async () => {
    partDocStoreMock({ content: sevenFeatureDoc(null) })
    renderPart()

    await waitFor(() => expect(screen.getByText('move face 1')).toBeInTheDocument())
    await waitFor(() => expect(solveMock).toHaveBeenCalled())

    const payload = firstPayload()
    expect(payload.features.map(f => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'])
    expect(payload.rollback_position).toBe(7)
  })

  it('solves nothing when the document opens parked at 0', async () => {
    partDocStoreMock({ content: sevenFeatureDoc(0) })
    renderPart()

    await waitFor(() => expect(screen.getByText('move face 1')).toBeInTheDocument())
    // Give the load effect a tick to (wrongly) issue a solve.
    await act(async () => { await Promise.resolve() })
    expect(solveMock).not.toHaveBeenCalled()
    expect(useEditorState.getState().rollbackPosition).toBe(0)
  })

  it('honours a mid-stack position on load', async () => {
    partDocStoreMock({ content: sevenFeatureDoc(3) })
    renderPart()

    await waitFor(() => expect(screen.getByText('move face 1')).toBeInTheDocument())
    await waitFor(() => expect(solveMock).toHaveBeenCalled())

    const payload = firstPayload()
    expect(payload.features.map(f => f.id)).toEqual(['f1', 'f2', 'f3'])
    expect(payload.rollback_position).toBe(3)
  })

  it('a swap while the first solve is in flight re-derives the bar before solving', async () => {
    const store = partDocStoreMock()
    const docA = sevenFeatureDoc(6, 'a')
    const docB = sevenFeatureDoc(3, 'b')
    store.load.mockImplementation((id: string) => Promise.resolve({
      kind: 'document' as const,
      content: id === 'doc-a' ? docA : docB,
      name: id,
    }))

    type SolveReturn = Awaited<ReturnType<typeof solveViaWorker>>
    let releaseA!: (value: SolveReturn) => void
    solveMock.mockImplementationOnce(() => new Promise<SolveReturn>(resolve => { releaseA = resolve }))
    solveMock.mockResolvedValue({ result: {}, bodies: {}, _build_state: null } as never)

    render(
      <MemoryRouter initialEntries={['/documents/doc-a']}>
        <Routes>
          <Route path="/documents/:uuid" element={<><OpenDocButton id="doc-b" /><Part /></>} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper },
    )

    await waitFor(() => expect(solveMock).toHaveBeenCalledTimes(1))
    // The document switch happens while doc A's solve is still pending.
    fireEvent.click(screen.getByText('open doc-b'))

    await waitFor(() => expect(solveMock).toHaveBeenCalledTimes(2))
    const bPayload = solveMock.mock.calls[1][0] as {
      features: Array<{ id: string }>
      rollback_position: number
    }
    expect(bPayload.features.map(f => f.id)).toEqual(['bf1', 'bf2', 'bf3'])
    expect(bPayload.rollback_position).toBe(3)

    // The stale A result lands after B: it must not replace B's doc.
    await act(async () => {
      releaseA({ result: {}, bodies: {}, _build_state: null } as never)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(usePartEditorStore.getState().doc?.features?.map(f => f.id))
        .toEqual(['bf1', 'bf2', 'bf3', 'bf4', 'bf5', 'bf6', 'bf7'])
    })
    expect(solveMock).toHaveBeenCalledTimes(2)
  })
})
