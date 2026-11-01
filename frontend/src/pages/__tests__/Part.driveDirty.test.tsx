// The drive bridge is a user edit, not a back door: a mutation step must take
// the same funnel a click does (handleMutation), so it sets the unsaved flag
// and clears a stale solve banner. Calling session.execute directly left the
// unsaved-changes guard thinking a drive-authored document was clean.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'

import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { resetCommandJournal } from '@/drive/journal'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const { solveMock } = vi.hoisted(() => ({ solveMock: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: solveMock,
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

// One real feature so the load solve reaches the worker and its failure can
// leave a banner behind.
const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
`

const OK_RESPONSE = { result: {}, bodies: {}, pick_bodies: {}, _build_state: null }

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

describe('a drive-surface mutation goes through the session funnel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock({ content: SKETCH_DOC })
    resetCommandJournal()
    useUnsavedChangesStore.getState().clearForNewDocument()
    // The load solve fails, leaving the stale banner the mutation must clear.
    solveMock.mockRejectedValueOnce(new Error('boom'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete (window as { __oversolved?: unknown }).__oversolved
  })

  it('sets the unsaved flag and clears the stale solve error', async () => {
    // The mutation's own solve is held open, so the banner can only disappear
    // through handleMutation, not through a later successful solve.
    let releaseSolve!: () => void
    solveMock.mockImplementationOnce(() => new Promise(resolve => {
      releaseSolve = () => resolve(OK_RESPONSE)
    }))

    // The load resolves inside act, so the page's own state updates land in a
    // test scope instead of warning after the fact.
    await act(async () => { renderPage() })
    await screen.findByText('Solver error: Error: boom')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)

    const surface = window.__oversolved
    expect(surface).toBeDefined()
    // The step runs synchronously up to the solve it starts; flush that inside
    // act so handleMutation's state update is not a warning after the fact.
    let running!: Promise<{ ok: boolean }>
    await act(async () => {
      running = surface!.script([
        { mutation: { type: 'rename_feature', featureId: 'sk1', label: 'Renamed' } as never },
      ])
      await Promise.resolve()
    })

    await waitFor(() => { expect(screen.queryByText(/Solver error/)).toBeNull() })
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    let outcome: Awaited<typeof running> | undefined
    await act(async () => {
      releaseSolve()
      outcome = await running
    })
    expect(outcome?.ok).toBe(true)

    // The first-solve callback is deferred one macrotask; flush it in act so its
    // fit and preview updates do not land after the test scope.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  })
})
