import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { Wrapper } from '@/__tests__/test-utils'

// undo-document-reset at the Part-page level: the store-owned fields
// (rollbackPosition, pickBoundary, editingFeatureId) and the sketch editor's
// module state only reset on a Part remount, because the resets live in
// useSyncPartEditorStore's unmount cleanup and Part's own unmount effect. The
// shared useDocumentState mock is static, so this suite renders the REAL page
// and simulates document B explicitly: seed A's stale editor state, navigate,
// and assert B starts fresh.

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

const DOC_A = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: A feature
`

// The clone case: B shares feature ids with A, so a stale editingFeatureId from
// A would survive into B's first solve (and violate assertEditingInvariant) if
// the remount did not reset it.
const DOC_B = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: B feature
`

function twoDocFetchMock() {
  return vi.fn((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
      } as Response)
    }
    if (url === '/api/documents/A') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ uuid: 'A', name: 'Doc A', content: DOC_A, permission: 'owner' }),
      } as Response)
    }
    if (url === '/api/documents/B') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ uuid: 'B', name: 'Doc B', content: DOC_B, permission: 'owner' }),
      } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

// Mirrors DocumentPage's <Part key={uuid} />: a uuid change must remount Part so
// the new document gets a fresh instance and a clean editor store.
function KeyedPartHost() {
  const { uuid } = useParams<{ uuid: string }>()
  return <Part key={uuid} />
}

function GoToB() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/documents/B')}>to B</button>
}

function countSolveCalls(): number {
  return (solveViaWorker as ReturnType<typeof vi.fn>).mock.calls.length
}

describe('Part - document change resets the editor store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      selectedPicks: new Map(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
      pendingDialog: null,
      contextMenu: null,
    })
  })

  it('a keyed remount to another document leaves the editor store fresh and B\'s first solve clean', async () => {
    vi.stubGlobal('fetch', twoDocFetchMock())

    render(
      <MemoryRouter initialEntries={['/documents/A']}>
        <Routes>
          <Route path="/documents/:uuid" element={<KeyedPartHost />} />
        </Routes>
        <GoToB />
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // A settles (its first solve finished reading the store, fields were null).
    await waitFor(() => { expect(countSolveCalls()).toBeGreaterThanOrEqual(1) })

    // A is now mid-edit: stale store-owned fields plus a stale pick session, the
    // exact state a clone navigation would carry into B without a remount. The
    // direct setState wakes the page's store subscribers, hence act().
    act(() => {
      usePartEditorStore.setState({
        editingFeatureId: 'ex1',
        pickBoundary: 1,
        rollbackPosition: 0,
      })
      useSketchEditorStore.setState({
        normalSelection: new Set(['?01;deadbeef:face']),
        activePickField: { featureId: 'ex1', field: 'bodies' },
        modeStack: ['pick'],
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    // B's first solve runs on the fresh instance. If the stale editing state
    // leaked, assertEditingInvariant would throw here (ex1 exists in B with
    // rollback 0 / pickBoundary 1 in hand), failing the test in test mode.
    await waitFor(() => { expect(countSolveCalls()).toBeGreaterThanOrEqual(2) })

    // The store-owned fields are B's own again: bar parked at B's feature count,
    // no edit in flight.
    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
    })
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()

    // The sketch editor module state did not survive the remount either.
    const sketchStore = useSketchEditorStore.getState()
    expect(sketchStore.activePickField).toBeNull()
    expect(sketchStore.modeStack).toEqual([])
    expect(sketchStore.normalSelection.size).toBe(0)
  })

  it('a remount clears A\'s half-open dimension gesture, so B\'s first pick does not trip the invariants', async () => {
    vi.stubGlobal('fetch', twoDocFetchMock())

    render(
      <MemoryRouter initialEntries={['/documents/A']}>
        <Routes>
          <Route path="/documents/:uuid" element={<KeyedPartHost />} />
        </Routes>
        <GoToB />
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // A settles.
    await waitFor(() => { expect(countSolveCalls()).toBeGreaterThanOrEqual(1) })

    // A is mid dimension gesture: one entity picked, cursor parked, tool armed.
    // The exact state a navigation would leak into B without the full reset.
    act(() => {
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:ex1:l1' }],
        dimensionCursorWorld: [5, 5],
        activeTool: 'dimension',
        drawPoints: [[0, 0]],
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    // B's first solve settles on the fresh instance.
    await waitFor(() => { expect(countSolveCalls()).toBeGreaterThanOrEqual(2) })

    // The gesture did not survive the remount: a stale dimensionPicks with no
    // dimension tool would failLoud under validateWithRepair, which
    // setActivePickField runs on every pick.
    expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    expect(() => {
      act(() => {
        useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'sketch' })
      })
    }).not.toThrow()
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'ex1', field: 'sketch' })
  })
})
