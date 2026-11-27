// The dimension placement reads the created ids off the mutation sink's return
// and cancels the placement when the session reports an empty insert. That
// contract broke when the sink was changed to hand the feature-handle pump a
// solve-idle promise: the placement then read the promise itself, saw no
// `ok`/`createdIds`, and rewound every dimension it had just inserted. The sink
// now returns the Result again and the pump waits on a separate idle port.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'
import { getSketchCallback } from '@/stores/sketchEditorStore'
import type { Mutation } from '@/types/cad'

const mocks = vi.hoisted(() => {
  const createdIds = ['c_len']
  const result = { ok: true as const, createdIds }
  const handleMutation = vi.fn(() => result)
  const idle = vi.fn(() => Promise.resolve())
  return { createdIds, result, handleMutation, idle }
})

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    handleMutation: mocks.handleMutation,
    session: {
      historyEntries: () => ({ undo: [], redo: [] }),
      canUndo: () => false,
      canRedo: () => false,
      subscribe: () => () => {},
      getDoc: () => null,
      isDirty: () => false,
      idle: mocks.idle,
    },
  }))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div>{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('../../components/layout/PartDocumentPanel', async () =>
  (await import('@/__tests__/test-utils')).partDocumentPanelMockModule())

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

describe('Part - the mutation sink and the solve-idle wait are separate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('returns the session Result and keeps the pump wait on its own port', async () => {
    renderPage()
    await waitFor(() => expect(getSketchCallback('awaitSolveIdle')).not.toBeNull())
    const sink = getSketchCallback('onMutation')!
    const mutation: Mutation = {
      type: 'add_constraint', featureId: 'sk1', kind: 'length',
      targets: ['entity:sk1:l1'], value: 10, id: 'c_len',
    }

    expect(sink(mutation)).toBe(mocks.result)
    expect(mocks.handleMutation).toHaveBeenCalledWith(mutation)

    const idle = getSketchCallback('awaitSolveIdle')!
    const wait = idle()
    expect(wait).toBeInstanceOf(Promise)
    expect(mocks.idle).toHaveBeenCalledTimes(1)
    await wait
  })
})
