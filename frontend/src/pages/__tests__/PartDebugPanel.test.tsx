// The F2 debug drawer. Part.debugToggle covers opening it; this covers what it
// then shows: the hover/selection readout, the tab switch, the live undo/redo
// stacks and the validate-on-rebuild toggle that drives the dev settings store.
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import PartDebugPanel from '@/pages/PartDebugPanel'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
import type { Mutation } from '@/types/cad'

const MOVE: Mutation = { type: 'move_entity', featureId: 'sk1', entityId: 'e1', delta: [1, 0] }

describe('PartDebugPanel', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({ hoveredSelectionId: null, hoveredVertexId: null, normalSelection: new Set() })
    usePartEditorStore.setState({ undoStack: [], redoStack: [] })
    useDevSettingsStore.setState({ validateOnRebuild: false })
  })

  it('renders nothing while the drawer is closed', () => {
    const { container } = render(<PartDebugPanel debugOpen={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the hovered id and the normal selection on the selection tab', () => {
    useSketchEditorStore.setState({
      hoveredSelectionId: '@ex1/face/0',
      normalSelection: new Set(['@body_ex1']),
    })
    render(<PartDebugPanel debugOpen />)

    expect(screen.getByText('@ex1/face/0')).toBeInTheDocument()
    expect(screen.getByText('Normal (1)')).toBeInTheDocument()
    expect(screen.getByText('@body_ex1')).toBeInTheDocument()
  })

  it('falls back to the hovered vertex when nothing else is hovered', () => {
    useSketchEditorStore.setState({ hoveredSelectionId: null, hoveredVertexId: 'vertex:sk1:e1:start' })
    render(<PartDebugPanel debugOpen />)
    expect(screen.getByText('vertex:sk1:e1:start')).toBeInTheDocument()
  })

  it('the validate checkbox reflects and updates the dev settings store', () => {
    render(<PartDebugPanel debugOpen />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)
    expect(useDevSettingsStore.getState().validateOnRebuild).toBe(true)
  })

  it('the Undo tab lists each stack with the mutation label', () => {
    usePartEditorStore.setState({ undoStack: [{ doc: {}, mutation: MOVE }], redoStack: [] })
    render(<PartDebugPanel debugOpen />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('Undo Stack (1)')).toBeInTheDocument()
    expect(screen.getByText('[0] move e1 in sk1')).toBeInTheDocument()
    expect(screen.getByText('Redo Stack (0)')).toBeInTheDocument()
    expect(screen.getByText('empty')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Selection' }))
    expect(screen.getByText('Hover')).toBeInTheDocument()
  })

  it('shows an empty placeholder for each stack independently', () => {
    render(<PartDebugPanel debugOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    // The two stacks sit in their own sections, so an empty redo stack must not
    // borrow the placeholder that belongs to the undo stack.
    expect(screen.getByText('Undo Stack (0)')).toBeInTheDocument()
    expect(screen.getByText('Redo Stack (0)')).toBeInTheDocument()
    expect(screen.getAllByText('empty')).toHaveLength(2)
  })

  it('lists the redo stack with its mutation label and raw payload', () => {
    usePartEditorStore.setState({ undoStack: [], redoStack: [{ doc: {}, mutation: MOVE }] })
    render(<PartDebugPanel debugOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(screen.getByText('Redo Stack (1)')).toBeInTheDocument()
    expect(screen.getByText('[0] move e1 in sk1')).toBeInTheDocument()
    // The raw JSON half is what makes a mutation with no describeMutation case
    // readable, so it must track the redo entry and not the undo one.
    expect(screen.getByText(/"type":"move_entity"/)).toBeInTheDocument()
  })
})
