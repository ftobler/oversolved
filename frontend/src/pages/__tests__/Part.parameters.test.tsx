// The parameter table's page wiring: the editor's Parameters button opens it,
// the rows come from the document's variables, and an edited cell leaves
// through the same mutation funnel every other edit uses (never a direct store
// write). The table's own rendering and commit rules are pinned by
// ParameterTable.test.tsx; this pins the wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

const seams = vi.hoisted(() => {
  const handleMutation = vi.fn()
  // The page reads its features and solve results from the doc hook, so the
  // mock's document is where this test seeds them (the store publish follows
  // the same values).
  const doc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'v1', kind: 'variable', label: 'width', variable: { expression: '20', unit: 'mm' } },
    ],
    part_style: {},
  }
  return { handleMutation, doc }
})

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    doc: seams.doc,
    handleMutation: seams.handleMutation,
    solveResults: { v1: { value: 20 } },
  }))
vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())
vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div data-testid="header">{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('../../components/layout/Sidebar', async () =>
  (await import('@/__tests__/test-utils')).sidebarMockModule())

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

describe('the parameter table in the part editor', () => {
  beforeEach(() => {
    seams.handleMutation.mockClear()
    vi.clearAllMocks()
  })
  afterEach(() => cleanup())

  it('opens from the Parameters button and shows the document variables', () => {
    renderPage()
    expect(screen.queryByText('Parameters')).toBeNull()
    // The parameter table lives with the feature tools, so the page enters
    // feature mode first (the same mode a user picks to author features).
    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Parameters'))
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect((screen.getByLabelText('Name of width') as HTMLInputElement).value).toBe('width')
    expect((screen.getByLabelText('Expression of width') as HTMLInputElement).value).toBe('20')
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('sends an edited expression through the mutation funnel', () => {
    renderPage()
    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Parameters'))
    const field = screen.getByLabelText('Expression of width')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '30 + 5' } })
    fireEvent.blur(field)
    expect(seams.handleMutation).toHaveBeenCalledWith({
      type: 'set_variable_field', featureId: 'v1', field: 'expression', value: '30 + 5',
    })
  })

  it('adds a parameter through add_variable with a minted feature id', () => {
    renderPage()
    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Parameters'))
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }))
    expect(seams.handleMutation).toHaveBeenCalledTimes(1)
    const mutation = seams.handleMutation.mock.calls[0][0] as { type: string; featureId: string; label?: string }
    expect(mutation.type).toBe('add_variable')
    expect(mutation.featureId.length).toBeGreaterThan(0)
    expect(mutation.label).toBe('var')
  })
})
