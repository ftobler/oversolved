// The routes outside the mutation funnel (a document load, entering and leaving
// an edit, Clear cache and Rebuild) must all reach the session's solve
// scheduler. Driving the real page is what proves the WIRING: a port wrapped
// around the raw solver in useDocumentState, useEditFeature or a page action
// would still solve, but idle() and inspect().solve would read an idle session
// while the worker is busy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'

import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { resetCommandJournal } from '@/drive/journal'
import { useEditorState } from '@/hooks/useEditorState'

const { solveMock } = vi.hoisted(() => ({ solveMock: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: solveMock,
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

// Two features so the edit route (Fillet 1) and the tree's own rows stay apart.
const FEATURE_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: fil1
    kind: fillet
    label: Fillet 1
    edges: []
    radius: 1
`

const OK_RESPONSE = { result: {}, bodies: {}, pick_bodies: {}, _build_state: null }

let held: Array<() => void> = []

function releaseAll(): void {
  held.splice(0).forEach(resolve => resolve())
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
  await waitFor(() => { expect(window.__oversolved).toBeDefined() })
  await screen.findByText('Fillet 1', { selector: '.feature-name' })
}

const solveFacts = () => window.__oversolved!.inspect().session.solve

// The action just issued a solve: the session must report it as in flight and
// idle() must stay unresolved until the held worker is released.
async function expectRouteSettles(callsBefore: number): Promise<void> {
  await waitFor(() => { expect(solveMock.mock.calls.length).toBeGreaterThan(callsBefore) })
  expect(solveFacts().pending).toBe(true)
  expect(solveFacts().running).toBe(true)

  let idleSettled = false
  const idling = window.__oversolved!.idle().then(() => { idleSettled = true })
  await act(async () => { await Promise.resolve() })
  expect(idleSettled).toBe(false)

  await act(async () => {
    releaseAll()
    await idling
  })
  await waitFor(() => { expect(solveFacts().pending).toBe(false) })
}

describe('every solve route reaches the session scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    held = []
    solveMock.mockReset()
    solveMock.mockImplementation(() => new Promise(resolve => {
      held.push(() => resolve(OK_RESPONSE))
    }))
    partDocStoreMock({ content: FEATURE_DOC })
    resetCommandJournal()
    useEditorState.setState({
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
      ghostMode: false,
    })
  })

  afterEach(() => {
    releaseAll()
    delete (window as { __oversolved?: unknown }).__oversolved
  })

  it('counts the load, edit enter/exit, Clear cache and Rebuild solves', async () => {
    await renderPage()

    // 1. The load solve.
    await expectRouteSettles(0)

    // 2. Entering the fillet edit (useEditFeature's tail).
    const beforeEnter = solveMock.mock.calls.length
    await act(async () => { fireEvent.click(screen.getAllByTitle('Edit fillet')[0]) })
    await waitFor(() => {
      const row = screen.getByText('Fillet 1', { selector: '.feature-name' }).closest('.feature-item')
      expect(row?.classList.contains('editing')).toBe(true)
    })
    await expectRouteSettles(beforeEnter)

    // 3. Leaving it (commitEditFeature -> exit cleanup).
    const beforeExit = solveMock.mock.calls.length
    await act(async () => {
      fireEvent.click(document.querySelector('.feature-item.editing .feature-ok-btn')!)
    })
    await waitFor(() => { expect(document.querySelector('.feature-item.editing')).toBeNull() })
    await expectRouteSettles(beforeExit)

    // 4. The tree's Rebuild button is the cache-clearing rebuild.
    const beforeClear = solveMock.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByLabelText('Rebuild geometry')) })
    await expectRouteSettles(beforeClear)
    expect(solveMock.mock.calls.at(-1)?.[1]).toMatchObject({ bypassCache: true })

    // 5. The feature menu's Rebuild is the plain one.
    const beforeRebuild = solveMock.mock.calls.length
    const filletRow = screen.getByText('Fillet 1', { selector: '.feature-name' }).closest('.feature-item') as HTMLElement
    await act(async () => { fireEvent.click(within(filletRow).getByTitle('More options')) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Rebuild' })) })
    await expectRouteSettles(beforeRebuild)
    expect((solveMock.mock.calls.at(-1)?.[1] as { bypassCache?: boolean } | undefined)?.bypassCache)
      .toBeUndefined()
  })
})
