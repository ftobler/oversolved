// The per-editor end-to-end glue: executeCommand('add_extrude') resolves the
// mounted page's registry, whose spec calls Part.handleAddFeature, whose
// mutation runs on the real DocSession. The Result the command returns is the
// session's Result, so the created feature id rides back to the caller.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const userFeatures = () =>
  usePartEditorStore.getState().features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

describe('Part command integration: add_extrude end to end', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    useEditorState.setState({
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
    partDocStoreMock()
  })

  it('changes the document through the real session and reports the created id', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper },
    )
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    let result: ReturnType<typeof executeCommand> | undefined
    await act(async () => { result = executeCommand('add_extrude') })
    await waitFor(() => expect(userFeatures()).toHaveLength(1))

    // The document changed: the mutation landed as a real feature.
    const created = userFeatures()[0]
    expect(created.kind).toBe('extrude')
    // The Result is the session's: the id the add minted is the one reported.
    expect(result).toEqual({ ok: true, createdIds: [created.id] })
  })
})
