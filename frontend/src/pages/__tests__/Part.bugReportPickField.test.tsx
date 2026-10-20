// The sketch-on-face FSM derives its trigger from the armed pick field plus the
// feature list. A bug report arms `{ featureId: 'bug-report:<setId>', field:
// 'plane' }`, which names no feature: it must not open a sketch edit, and the
// real sketch field must still be able to, proving the harness observes the
// mechanism rather than a permanently inert page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ReactNode } from 'react'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())
vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div data-testid="header">{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({
  default: () => <div data-testid="measurement-readout" />,
}))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())

const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
`

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

describe('Part ignores a bug-report pick field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock({ content: SKETCH_DOC })
  })
  afterEach(() => cleanup())

  it('does not enter the sketch plane FSM, but still does for a real sketch field', async () => {
    renderPage()
    await waitFor(() => expect(usePartEditorStore.getState().doc).not.toBeNull())

    await act(async () => {
      useEditorState.getState().setActivePickField({
        featureId: 'bug-report:set-1',
        field: 'plane',
        multi: true,
      })
    })

    expect(useEditorState.getState().editingFeatureId).toBeNull()
    expect(document.querySelector('.feature-edit-panel')).toBeNull()

    await act(async () => {
      useEditorState.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBe('sk1'))
  })
})
