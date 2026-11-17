// The part editor's toolbar speaks the user's word: a part, not a body. The
// schema test covers the feature editors' field text and buildContextMenu's own
// test covers the parts-list menu; this covers the toolbar titles, the one name
// built in JSX rather than a schema. The `body` ids and mutation types behind
// the buttons stay as they are.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

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

const BODY_WORD = /\bbod(?:y|ies)\b/i

describe('part editor toolbar wording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock()
  })

  it('titles the delete tool Delete Part and names no body in the toolbar', () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper },
    )
    fireEvent.click(screen.getByTitle('Feature mode'))

    expect(screen.getByTitle('Delete Part')).toBeInTheDocument()
    expect(screen.queryByTitle('Delete Body')).toBeNull()

    const titles = [...document.querySelectorAll('.editor-toolbar [title]')]
      .map(node => node.getAttribute('title') ?? '')
    const alts = [...document.querySelectorAll('.editor-toolbar [alt]')]
      .map(node => node.getAttribute('alt') ?? '')
    expect([...titles, ...alts].filter(text => BODY_WORD.test(text))).toEqual([])
  })
})
