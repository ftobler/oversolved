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
    // An add cannot start a part, so on an empty document the command seeds
    // `new`; this is the document effect a first extrusion needs to solve.
    expect(created.kind === 'extrude' ? created.extrude.operation : undefined).toBe('new')
    // The Result is the session's: the id the add minted is the one reported.
    expect(result).toEqual({ ok: true, createdIds: [created.id] })
  })

  it('keeps the add default once the document already has a body producer', async () => {
    // The seed reads the document, so a part whose solve has not landed yet
    // (no bodies in the store) still starts the new extrude as an add.
    partDocStoreMock({
      content: [
        'version: 1',
        'kind: part',
        'features:',
        '  - id: sk1',
        '    kind: sketch',
        '    plane: "@builtin_plane_top"',
        '    entities: []',
        '    initial: {}',
        '    constraints: []',
        '  - id: ex1',
        '    kind: extrude',
        '    extrude:',
        '      sketch: "@sk1"',
        '      distance: 5',
        '      direction: normal',
        '      operation: new',
        '',
      ].join('\n'),
    })
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

    await act(async () => { executeCommand('add_extrude') })
    // sk1 and ex1 come from the document; the third is the new extrude.
    await waitFor(() => expect(userFeatures()).toHaveLength(3))

    const created = userFeatures().find(f => f.kind === 'extrude' && f.id !== 'ex1')
    expect(created?.kind).toBe('extrude')
    expect(created?.kind === 'extrude' ? created.extrude.operation : undefined).toBeUndefined()
  })
})
