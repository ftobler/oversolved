// A part the loader refuses must not just drop out of the editor: the page
// keeps the raw text reachable in a read-only dialog. Viewport-free: the
// dialog is the page's, not the scene's.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

describe('Part raw document fallback', () => {
  it('offers the raw text read-only when validation refuses the document', async () => {
    const content = 'version: 1\nkind: part\nfeatures:\n  - id: ex1\n    kind: extrude\n    extrude:\n      distance: .nan\n'
    partDocStoreMock({ content, name: 'Broken Bracket' })
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper },
    )

    await screen.findByText('Could not open "Broken Bracket"')
    const text = screen.getByLabelText('Raw document text') as HTMLTextAreaElement
    expect(text.value).toBe(content)
    expect(text.readOnly).toBe(true)
    // The banner and the dialog both name the field.
    expect(screen.getAllByText(/features\[0\]\.extrude\.distance/).length).toBeGreaterThan(0)
  })
})
