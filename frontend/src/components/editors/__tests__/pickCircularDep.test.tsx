/**
 * A pick chip must not accept geometry from its own feature or from a later
 * one: the solver would need the result of the feature it is about to build.
 * The viewport renders the edited feature's preview body, so the click reaches
 * the chip -- usePickField is what rejects it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import type { FeatureEditorSchema } from '@/components/editors/FeatureEditor'
import { MOVE_FACE_SCHEMA, FILLET_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { ToastProvider } from '@/contexts/ToastContext'
import type { PartFeature } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch' },
  { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
]

const SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_test', subKey: 'test', defaults: { body: '' },
  fields: [{ type: 'pick', key: 'body', label: 'Body' }],
}

function renderEditorFor(fid: string, onMutation: () => void) {
  const feature = { id: fid, kind: 'test', test: { body: '' } } as unknown as PartFeature
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={SCHEMA} />)
  fireEvent.click(document.querySelector('.feature-pick-chip')!)  // activate the field
}

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

beforeEach(() => {
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
})

describe('pick chip circular-dependency guard', () => {
  it('accepts geometry from an earlier feature', () => {
    const onMutation = vi.fn()
    renderEditorFor('ex1', onMutation)
    pick('@sk1')
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'ex1', field: 'body', value: '@sk1' })
  })

  it('rejects the host feature picking its own body', () => {
    const onMutation = vi.fn()
    renderEditorFor('ex1', onMutation)
    pick('@body_ex1')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('rejects the host feature picking its own face', () => {
    const onMutation = vi.fn()
    renderEditorFor('ex1', onMutation)
    pick('@ex1/face/3')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('rejects geometry from a later feature', () => {
    const onMutation = vi.fn()
    renderEditorFor('ex1', onMutation)
    pick('@body_ex2')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('drops the rejected selection but keeps the field open for a valid pick', () => {
    const onMutation = vi.fn()
    renderEditorFor('ex1', onMutation)

    pick('@body_ex1')
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(document.querySelector('.feature-pick-chip')!.classList.contains('picking')).toBe(true)

    pick('@sk1')
    expect(onMutation).toHaveBeenCalledTimes(1)
  })
})

/** Mount an editor inside a live ToastProvider and arm its first pick field.
 *  The provider is real so a regression back to a toast would show up as a
 *  second copy of the text, which `expectRefusalInDialog`'s getByText rejects. */
function renderArmed(feature: PartFeature, schema: FeatureEditorSchema, onMutation: () => void, features?: PartFeature[]) {
  render(
    <ToastProvider>
      <FeatureEditor feature={feature} onMutation={onMutation} features={features} schema={schema} />
    </ToastProvider>,
  )
  fireEvent.click(document.querySelector('.feature-pick-chip')!)
}

/** The refusal is shown once, inside the refused field's row of the dialog. */
function expectRefusalInDialog(text: string) {
  const el = screen.getByText(text)
  expect(el.closest('.feature-field-row')).not.toBeNull()
  expect(el.closest('.feature-field-row')!.querySelector('.feature-pick-chip.picking')).not.toBeNull()
}

const FILLET = { id: 'fi1', kind: 'fillet', fillet: { edges: [], radius: 1 } } as unknown as PartFeature

describe('rejected-pick feedback', () => {
  it('a validatePick refusal shows the field reason and dispatches no mutation', () => {
    // The real fillet gate: only `?` queries carry a named query, so a
    // topo-fallback edge (@body_<id>/edge/N) is refused with that reason
    // instead of vanishing silently. No `features` prop: the build-order guard
    // would otherwise reject this very pick first.
    const onMutation = vi.fn()
    renderArmed(FILLET, FILLET_SCHEMA, onMutation)

    pick('@body_ex1/edge/0')

    expect(onMutation).not.toHaveBeenCalled()
    expectRefusalInDialog('Pick refused: this edge has no named query')
  })

  it('a misclicked plane in an edge field is refused as the wrong kind', () => {
    // Same gate, different refusal: the reason names what was picked, so a
    // plane click cannot be reported as an edge whose name is missing.
    const onMutation = vi.fn()
    renderArmed(FILLET, FILLET_SCHEMA, onMutation)

    pick('@builtin_plane_top')

    expect(onMutation).not.toHaveBeenCalled()
    expectRefusalInDialog('Pick refused: pick an edge')
  })

  it('a move-face pick of a named cylinder face is refused with the planarity reason', () => {
    // The whole refusal reason comes from the field, so a gate whose rule is not
    // "no named query" cannot misreport one. This is the friction the field
    // reasons exist for: a perfectly named bore-wall query, refused only because
    // move-face is planar, used to be announced as "this edge has no named
    // query" (wrong kind, wrong element, wrong cause).
    const onMutation = vi.fn()
    const feature = { id: 'mf1', kind: 'move_face', move_face: { faces: [], distance: 5 } } as unknown as PartFeature
    renderArmed(feature, MOVE_FACE_SCHEMA, onMutation)

    pick('?15,19,1e,2a;@u|u_c1dea7bb6244c5c3@SY-uXCL_uS188WwBa7Hwywkv@body_SY-uXCL_uS188WwBa7Hwywkv@UgoC6zEmpmK7z5yqVQHdagP8/Wb0Rxrzw10E_-ag_:cylinderface')

    expect(onMutation).not.toHaveBeenCalled()
    expectRefusalInDialog('Pick refused: move face only moves planar faces')
  })

  it('a build-order rejection shows its reason in the dialog and keeps the field open', () => {
    const onMutation = vi.fn()
    const feature = { id: 'ex1', kind: 'test', test: { body: '' } } as unknown as PartFeature
    renderArmed(feature, SCHEMA, onMutation, FEATURES)

    pick('@body_ex1')

    expect(onMutation).not.toHaveBeenCalled()
    expectRefusalInDialog('Pick refused: can only reference earlier features')
    expect(document.querySelector('.feature-pick-chip')!.classList.contains('picking')).toBe(true)
  })

  it('the refusal clears on the next accepted pick', () => {
    // A stale reason next to a pick that landed would read as if the good pick
    // had been refused too.
    const onMutation = vi.fn()
    renderArmed(FILLET, FILLET_SCHEMA, onMutation)

    pick('@body_ex1/edge/0')
    expect(document.querySelector('.status-message')).not.toBeNull()

    pick('?9;@body_ex1:lineedge')
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.status-message')).toBeNull()
  })

  it('removing a chip value with its x clears the refusal', () => {
    // The x goes around the unpick path, so the hook's re-arm drops it.
    const onMutation = vi.fn()
    const withEdge = { id: 'fi1', kind: 'fillet', fillet: { edges: ['?1;a'], radius: 1 } } as unknown as PartFeature
    renderArmed(withEdge, FILLET_SCHEMA, onMutation)

    pick('@body_ex1/edge/0')
    expect(document.querySelector('.status-message')).not.toBeNull()

    fireEvent.click(document.querySelector('.feature-pick-chip-item-remove')!)
    expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({ type: 'remove_fillet_edge' }))
    expect(document.querySelector('.status-message')).toBeNull()
  })

  it('a box whose every element lands clears an earlier refusal', () => {
    const onMutation = vi.fn()
    renderArmed(FILLET, FILLET_SCHEMA, onMutation)

    pick('@body_ex1/edge/0')
    expect(document.querySelector('.status-message')).not.toBeNull()

    act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(['?1;a', '?2;b'])) })
    expect(onMutation).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.status-message')).toBeNull()
  })

  it('the refusal hides when the field is disarmed', () => {
    // The reason explains the armed field's last click; once the user leaves
    // the field it no longer describes anything they are doing.
    const onMutation = vi.fn()
    renderArmed(FILLET, FILLET_SCHEMA, onMutation)

    pick('@body_ex1/edge/0')
    expect(document.querySelector('.status-message')).not.toBeNull()

    act(() => { useSketchEditorStore.getState().setActivePickField(null) })
    expect(document.querySelector('.status-message')).toBeNull()
  })
})
