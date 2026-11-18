/**
 * The want-key intake rule belongs to the FIELD, not to Delete Part. A body
 * field holds parts wherever it appears: the transform's moved bodies, the
 * boolean's tools and the Delete Part list all treat a second face of a held
 * part as that part's removal pick, and all land a lasso as one batch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { BOOLEAN_SCHEMA, TRANSFORM_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import type { PartFeature, PartResult } from '@/types/cad'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })
const PICK_PARTS: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
}

const FACE_EX1 = 'face:ex1:?9;@body_ex1:face'
const OTHER_EX1 = '@body_ex1/edge/3'
const FACE_EX2 = 'face:ex2:?9;@body_ex2:face'
const OTHER_EX2 = '@body_ex2/edge/3'

function transformFeature(bodies: string[] = []): PartFeature {
  return {
    id: 'tr1',
    kind: 'transform',
    label: 'Transform',
    transform: {
      bodies, operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1,
    },
  } as unknown as PartFeature
}

function booleanFeature(tools: string[] = [], target = ''): PartFeature {
  return {
    id: 'bo1',
    kind: 'boolean',
    label: 'Boolean',
    boolean: { operation: 'subtract', target, tools },
  } as unknown as PartFeature
}

function armChip(index: number) {
  fireEvent.click(document.querySelectorAll('.feature-pick-chip')[index])
}

function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

function lasso(selectionIds: string[]) {
  act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(selectionIds)) })
}

beforeEach(() => {
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
  usePartEditorStore.setState({ pickParts: PICK_PARTS, parts: PICK_PARTS })
})

describe('transform.bodies intake', () => {
  it('a second pick of a held part removes it', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor feature={transformFeature([FACE_EX1])} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />,
    )
    armChip(0)
    pick(OTHER_EX1)
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_transform_body', featureId: 'tr1', index: 0 })
    expect(onMutation).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'add_transform_body' }))
  })

  it('a lasso over two parts is one batch with one add per part', () => {
    const onMutation = vi.fn()
    const onMutationBatch = vi.fn()
    render(
      <FeatureEditor
        feature={transformFeature()}
        onMutation={onMutation}
        onMutationBatch={onMutationBatch}
        schema={TRANSFORM_SCHEMA}
      />,
    )
    armChip(0)
    lasso([FACE_EX1, OTHER_EX1, FACE_EX2, OTHER_EX2])

    expect(onMutationBatch).toHaveBeenCalledTimes(1)
    expect(onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_transform_body', featureId: 'tr1', bodyQuery: FACE_EX1 },
      { type: 'add_transform_body', featureId: 'tr1', bodyQuery: FACE_EX2 },
    ])
    expect(onMutation).not.toHaveBeenCalled()
  })
})

describe('boolean.tools intake', () => {
  // The subtract editor arms Target first and Tools second.
  const TOOLS_CHIP = 1

  it('a second pick of a held tool removes it', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={booleanFeature([FACE_EX1], '@body_ex2')}
        onMutation={onMutation}
        schema={BOOLEAN_SCHEMA}
      />,
    )
    armChip(TOOLS_CHIP)
    pick(OTHER_EX1)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'remove_boolean_tool', featureId: 'bo1', tool: FACE_EX1,
    })
    expect(onMutation).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'add_boolean_tool' }))
  })

  it('a lasso over two tools is one batch with one add per part', () => {
    const onMutation = vi.fn()
    const onMutationBatch = vi.fn()
    render(
      <FeatureEditor
        feature={booleanFeature([], '@body_ex9')}
        onMutation={onMutation}
        onMutationBatch={onMutationBatch}
        schema={BOOLEAN_SCHEMA}
      />,
    )
    armChip(TOOLS_CHIP)
    lasso([FACE_EX1, OTHER_EX1, FACE_EX2, OTHER_EX2])

    expect(onMutationBatch).toHaveBeenCalledTimes(1)
    expect(onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_boolean_tool', featureId: 'bo1', tool: FACE_EX1 },
      { type: 'add_boolean_tool', featureId: 'bo1', tool: FACE_EX2 },
    ])
    expect(onMutation).not.toHaveBeenCalled()
  })
})
