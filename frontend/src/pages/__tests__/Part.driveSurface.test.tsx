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
    useEditorState.setState({ activeTool: null, editingFeatureId: null, normalSelection: new Set() })
  })

  afterEach(() => {
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

    act(() => { unmount() })
    expect(window.__oversolved).toBeUndefined()
  })
})
