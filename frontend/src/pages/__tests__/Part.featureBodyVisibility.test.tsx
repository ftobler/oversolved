// The sweep's tree eye must reach the document, not just render. This mounts the
// real Part page with the Viewport mocked out, clicks the eye on a sweep row,
// and reads the derived visible-feature set the page publishes: the sweep leaves
// it, which is what the body renderer reads. The body half is driven separately
// by getBodiesToRender in usePartDoc.featureBodyVisibility.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

const shown = (id: string) => usePartEditorStore.getState().visibleFeatures.has(id)

const sweptPart = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
  - id: hx1
    kind: helix
    helix: {}
  - id: sw1
    kind: sweep
    sweep: { sketch: '@sk1', path: '@hx1' }
`

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

describe('Part - feature body visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorState.setState({
      normalSelection: new Set(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
  })

  it('the sweep eye hides the feature through set_feature_visibility', async () => {
    renderPart(sweptPart)
    await screen.findByTitle('Feature mode')
    await waitFor(() => expect(shown('sw1')).toBe(true))

    const row = screen.getByText('sw1').closest('.feature-item') as HTMLElement
    const eye = row.querySelector('.feature-visibility-btn')
    expect(eye).not.toBeNull()

    await act(async () => { fireEvent.click(eye!) })

    await waitFor(() => expect(shown('sw1')).toBe(false))
    // The row dims from the same derived set, so the eye and the body layer
    // cannot disagree about what is hidden.
    expect(row.classList.contains('invisible')).toBe(true)
  })
})
