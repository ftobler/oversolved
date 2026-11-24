import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EXTRUDE_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useEditorState } from '@/hooks/useEditorState'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartFeature } from '@/types/cad'

const extrudeFeature = (sketch: string[]): PartFeature => ({
  id: 'ex1', kind: 'extrude', extrude: { sketch, distance: 3 },
} as PartFeature)

beforeEach(() => {
  useEditorState.setState({
    normalSelection: new Set(), activePickField: null, modeStack: [], chipOwnedSelection: new Set(),
  })
  useSketchEditorStore.setState({ chipOwnedSelection: new Set() })
  usePartEditorStore.setState({ solveResults: {} })
})

describe('PickField clear all', () => {
  it('shows Clear all only when a multi field holds at least two chips', () => {
    const two = render(<FeatureEditor feature={extrudeFeature(['a', 'b'])} onMutation={vi.fn()} schema={EXTRUDE_SCHEMA} />)
    expect(screen.getByTitle('Clear all')).toBeTruthy()
    two.unmount()

    render(<FeatureEditor feature={extrudeFeature(['a'])} onMutation={vi.fn()} schema={EXTRUDE_SCHEMA} />)
    expect(screen.queryByTitle('Clear all')).toBeNull()
  })

  it('dispatches one clear mutation and arms the field', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={extrudeFeature(['a', 'b', 'c'])} onMutation={onMutation} schema={EXTRUDE_SCHEMA} />)
    fireEvent.click(screen.getByTitle('Clear all'))
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledWith({ type: 'clear_pick_field', featureId: 'ex1', field: 'sketch' })
    expect(document.querySelector('.feature-pick-chip')!.classList.contains('picking')).toBe(true)
  })
})
