// A variable's rename dialog folds spaces into underscores as they are typed,
// while a feature's keeps them. Driven through the real usePartDoc so the
// committed label and its one undo entry are both observed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/hooks/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const DOC = `version: 1
kind: part
features:
  - id: v1
    kind: variable
    label: wall
    variable: { expression: 5 }
  - id: ex1
    kind: extrude
    label: side
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
`

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

function cardButton(className: string): HTMLElement {
  return document.querySelector(`.feature-edit-panel ${className}`) as HTMLElement
}

function renameFromCard(name: string) {
  fireEvent.click(cardButton('.feature-rename-btn'))
  const box = document.querySelector('.dialog-component') as HTMLElement
  fireEvent.change(within(box).getByLabelText('Name'), { target: { value: name } })
  fireEvent.click(within(box).getByRole('button', { name: 'Rename' }))
}

async function openEditor(kind: 'variable' | 'extrude') {
  await waitFor(() => expect(screen.getByTitle('Feature mode')).toBeInTheDocument())
  fireEvent.click(screen.getByTitle('Feature mode'))
  fireEvent.click(screen.getByTitle(`Edit ${kind}`))
  await waitFor(() => expect(document.querySelector('.feature-edit-panel')).not.toBeNull())
}

beforeEach(() => {
  vi.clearAllMocks()
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    activePickField: null,
    modeStack: [],
    editingFeatureId: null,
  })
})

describe('Part - rename normalization per target kind', () => {
  it('commits a variable rename with spaces folded and undoable as one mutation', async () => {
    partDocStoreMock({ content: DOC })
    renderPart()
    await openEditor('variable')

    renameFromCard('wall thickness')

    await waitFor(() => {
      expect(usePartEditorStore.getState().features.find(f => f.id === 'v1')!.label).toBe('wall_thickness')
    })
    expect(usePartEditorStore.getState().features.find(f => f.id === 'ex1')!.label).toBe('side')

    await act(async () => { executeCommand('undo') })
    await waitFor(() => {
      expect(usePartEditorStore.getState().features.find(f => f.id === 'v1')!.label).toBe('wall')
    })
  })

  it('keeps spaces in an extrude rename', async () => {
    partDocStoreMock({ content: DOC })
    renderPart()
    await openEditor('extrude')

    renameFromCard('side wall')

    await waitFor(() => {
      expect(usePartEditorStore.getState().features.find(f => f.id === 'ex1')!.label).toBe('side wall')
    })
  })

  it('still refuses a variable name the validator rejects after normalization', async () => {
    partDocStoreMock({ content: DOC })
    renderPart()
    await openEditor('variable')

    fireEvent.click(cardButton('.feature-rename-btn'))
    const box = document.querySelector('.dialog-component') as HTMLElement
    fireEvent.change(within(box).getByLabelText('Name'), { target: { value: 'my-var' } })
    expect(within(box).getByRole('button', { name: 'Rename' })).toBeDisabled()
    fireEvent.click(within(box).getByRole('button', { name: 'Rename' }))
    expect(usePartEditorStore.getState().features.find(f => f.id === 'v1')!.label).toBe('wall')
  })
})
