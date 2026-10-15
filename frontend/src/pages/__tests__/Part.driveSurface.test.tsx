// The Part page installs the drive surface in dev/test builds (Q6): the global
// must exist once the editor is mounted, answer with the registered command
// table, and be gone on unmount. The bridge's own behaviour is pinned in
// src/drive/__tests__; this suite pins the page wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'

import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'
import { resetCommandJournal } from '@/drive/journal'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

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

describe('Part drive surface installation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock()
    resetCommandJournal()
    useEditorState.setState({ activeTool: null, editingFeatureId: null, normalSelection: new Set() })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete (window as { __oversolved?: unknown }).__oversolved
  })

  it('installs window.__oversolved with the live command table and removes it on unmount', async () => {
    const { unmount } = renderPage()
    await screen.findByTitle('Feature mode')

    const surface = window.__oversolved
    expect(surface).toBeDefined()
    const commands = surface!.commands()
    expect(commands.some(c => c.id === 'undo' && c.label === 'Undo')).toBe(true)
    expect(commands.some(c => c.id === 'set_tool_rect')).toBe(true)

    // A real execution through the page's registry reaches the session and
    // records an undo entry.
    const result = surface!.execute('toggle_plane_visibility')
    expect(result.ok).toBe(true)
    await waitFor(() => { expect(window.__oversolved!.inspect().session.history.undo).toHaveLength(1) })

    const inspection = surface!.inspect()
    expect(inspection.session.docId).toBe('doc-1')
    expect(inspection.session.dirty).toBe(true)
    // The whole readout is JSON-safe.
    expect(JSON.parse(JSON.stringify(inspection)).session.docId).toBe('doc-1')

    // The session mutation seam recorded the change the command produced (not
    // the command itself), and the repro carries the baseline it started from.
    const journal = surface!.journal()
    expect(journal).toHaveLength(1)
    expect(journal[0].kind).toBe('mutation')
    expect(journal[0].payload).toEqual({ type: 'toggle_plane_visibility' })
    expect(journal[0].label).toBe('toggle plane visibility')
    expect(journal[0].docHashBefore).not.toBe(journal[0].docHashAfter)
    const repro = surface!.repro()
    expect(repro).not.toBeNull()
    expect(repro!.docHash).toMatch(/^[0-9a-f]{64}$/)
    expect((repro!.doc as { kind?: string }).kind).toBe('part')

    act(() => { unmount() })
    expect(window.__oversolved).toBeUndefined()
  })

  it('leaves the bridge uninstalled in a production-mode module graph', async () => {
    // The regular suite runs in test mode, so the gate const is true for every
    // other test. Stubbing the env and reloading the graph is the only way to
    // exercise the folded-off build: the page module must come up with the
    // gate false and install nothing. (The production bundler folds the same
    // const to `false` and drops the installer and journal entirely.)
    vi.stubEnv('DEV', false)
    vi.stubEnv('MODE', 'production')
    vi.resetModules()
    try {
      const testUtils = await import('@/__tests__/test-utils')
      testUtils.partDocStoreMock()
      const { default: FreshPart } = await import('@/pages/Part')
      render(
        <MemoryRouter initialEntries={['/documents/doc-1']}>
          <Routes>
            <Route path="/documents/:uuid" element={<FreshPart />} />
          </Routes>
        </MemoryRouter>,
        { wrapper: testUtils.Wrapper },
      )
      await screen.findByTitle('Feature mode')
      expect(window.__oversolved).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
