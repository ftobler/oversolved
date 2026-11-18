import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { DELETE_PART_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartFeature, PartResult } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import { bodyMarkSelected } from '@/components/Geometry3D/constants'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })

// The pick layer a Delete Part edit is made in: both parts still exist there,
// even though the feature's own preview has already removed the one it targets.
const PICK_PARTS: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
}

const FACE_EX1 = 'face:ex1:?9;@body_ex1:face'
const OTHER_FACE_EX1 = '@body_ex1/edge/3'
const FACE_EX2 = 'face:ex2:?9;@body_ex2:face'
const OTHER_FACE_EX2 = '@body_ex2/edge/3'

function makeFeature(parts: string[] = []): PartFeature {
  return {
    id: 'db1',
    kind: 'delete_body',
    label: 'Delete Part',
    delete_body: { bodies: parts },
  }
}

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

/** Simulate the rubber-band box: one replace-all set of every boxed id. */
function lasso(selectionIds: string[]) {
  act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(selectionIds)) })
}

function armChip() {
  fireEvent.click(document.querySelector('.feature-pick-chip')!)
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

describe('DeleteBodyEditor (via FeatureEditor)', () => {
  it('renders empty chip when no body selected', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_PART_SCHEMA} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders one chip item per picked body', () => {
    const feature = makeFeature(['@body_ex1', '@body_ex2'])
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_PART_SCHEMA} />)
    const chips = [...document.querySelectorAll('.feature-pick-chip-item-text')]
    expect(chips.map(c => c.textContent)).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('clicking chip toggles picking state', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_PART_SCHEMA} />)
    const chip = document.querySelector('.feature-pick-chip')!
    expect(chip.classList.contains('picking')).toBe(false)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })

  it('remove button emits remove_delete_body_ref for that index', () => {
    const feature = makeFeature(['@body_ex1', '@body_ex2'])
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />)
    const removeBtns = document.querySelectorAll('.feature-pick-chip-item-remove')
    fireEvent.click(removeBtns[1])
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_delete_body_ref', featureId: 'db1', index: 1 })
  })

  it('picking a body emits add_delete_body_ref and keeps the field open', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />)
    armChip()
    pick(FACE_EX1)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: FACE_EX1,
    })
    // multi: the chip stays armed so the next body can be picked without re-arming.
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'db1', field: 'bodies', multi: true })
  })

  it('stores a face pick verbatim when it is already an ancestry query', () => {
    // What the viewport actually writes for a b-rep face click: the raw query,
    // which resolves through the face to the one body that owns it.
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />)
    armChip()
    const faceQuery = '?15,4,9,7;@u|u_f38db052aaf9026c@ex1@body_ex1@cls_zn:flatface'
    pick(faceQuery)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: faceQuery,
    })
  })

  it('collects a second pick of another part instead of replacing the first', () => {
    const onMutation = vi.fn()
    // The doc mutation is external to the editor, so re-render with the value the
    // first pick would have written and confirm the second pick still appends.
    const { rerender } = render(
      <FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />,
    )
    armChip()
    pick(FACE_EX1)
    rerender(
      <FeatureEditor feature={makeFeature([FACE_EX1])} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />,
    )
    pick(FACE_EX2)
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: FACE_EX2,
    })
    expect(onMutation).toHaveBeenCalledTimes(2)
  })

  it('a second pick of the same part removes the part', () => {
    // The user's scenario: picking one edge then another edge of part 1 is a
    // pick and its removal pick, not two chips for the same part.
    const onMutation = vi.fn()
    render(
      <FeatureEditor feature={makeFeature([FACE_EX1])} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />,
    )
    armChip()
    pick(OTHER_FACE_EX1)
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_delete_body_ref', featureId: 'db1', index: 0 })
    expect(onMutation).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'add_delete_body_ref' }))
  })

  it('a lasso over two parts adds each part once as one batch', () => {
    const onMutation = vi.fn()
    const onMutationBatch = vi.fn()
    render(
      <FeatureEditor
        feature={makeFeature()}
        onMutation={onMutation}
        onMutationBatch={onMutationBatch}
        schema={DELETE_PART_SCHEMA}
      />,
    )
    armChip()
    // The box clips two faces of each part: four ids, two parts.
    lasso([FACE_EX1, OTHER_FACE_EX1, FACE_EX2, OTHER_FACE_EX2])

    expect(onMutationBatch).toHaveBeenCalledTimes(1)
    expect(onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: FACE_EX1 },
      { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: FACE_EX2 },
    ])
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('a lasso over a held part leaves it in place and adds the other', () => {
    const onMutationBatch = vi.fn()
    render(
      <FeatureEditor
        feature={makeFeature([FACE_EX1])}
        onMutation={vi.fn()}
        onMutationBatch={onMutationBatch}
        schema={DELETE_PART_SCHEMA}
      />,
    )
    armChip()
    lasso([OTHER_FACE_EX1, FACE_EX2])

    expect(onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: FACE_EX2 },
    ])
  })

  it('refuses a plane pick with the field message and adds nothing', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />)
    armChip()
    pick('@builtin_plane_top')

    expect(onMutation).not.toHaveBeenCalled()
    expect(document.querySelector('.status-message')?.textContent ?? document.body.textContent)
      .toContain('Pick refused: pick a face, edge or part')
    // The field stays armed for valid geometry.
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })

  it('stores a picked ref verbatim, never narrowed to one body', () => {
    // This field must NOT carry `resolvePartPickRef` the way the singular body
    // fields do. That transform coerces a feature ref to a body id
    // (`@ex1` -> `@body_ex1`), and here `@ex1` means EVERY body that feature
    // made -- coercing it deletes the first split sibling and leaves the rest
    // standing, which is the bug `resolvePartIds` exists to prevent. The topo
    // fallback is likewise left for the kernel to resolve.
    const onMutation = vi.fn()
    for (const picked of ['@ex1', '@body_ex1/face/0']) {
      onMutation.mockClear()
      const { unmount } = render(
        <FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />,
      )
      armChip()
      pick(picked)
      expect(onMutation, picked).toHaveBeenCalledWith({
        type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: picked,
      })
      unmount()
      act(() => { useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  }) })
    }
  })

  it('re-picking an already-picked body removes it again', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor feature={makeFeature(['@body_ex1'])} onMutation={onMutation} schema={DELETE_PART_SCHEMA} />,
    )
    armChip()
    // Arming syncs the chip's values into the selection; toggling one back off is
    // the viewport re-click.
    pick('@body_ex1')
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_delete_body_ref', featureId: 'db1', index: 0 })
  })

  it('tracks its own mirrored value as chip-owned, so the doomed body keeps its mark', () => {
    // The create path arms this chip right after add_delete_body, and the mirror
    // it writes to normalSelection is what turned the doomed preview white. This
    // pins the discriminator the fix keys on: the editor's own value arrives as
    // chip-owned, so the body mark does not read it as a user selection.
    render(
      <FeatureEditor feature={makeFeature(['@body_ex1'])} onMutation={vi.fn()} schema={DELETE_PART_SCHEMA} />,
    )
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    const state = useSketchEditorStore.getState()
    expect(state.normalSelection.has('@body_ex1')).toBe(true)
    expect(state.chipOwnedSelection.has('@body_ex1')).toBe(true)
    expect(bodyMarkSelected({
      bodyId: 'body_ex1',
      normalSelection: state.normalSelection,
      chipOwnedSelection: state.chipOwnedSelection,
      doomed: true,
    })).toBe(false)
  })
})
