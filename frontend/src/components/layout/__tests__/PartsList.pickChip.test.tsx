/**
 * A Parts card row is a pick target while a chip that names parts is armed: the
 * row lands its part in the chip exactly as a click on the part's geometry in
 * the viewport does, and a second click on a held part takes it out. The row
 * click rides the one selection route (toggleNormalSelection), so these tests
 * wire the real store action as onToggleSelect instead of a spy: a spy would
 * pass even if the click never reached the selection.
 *
 * During a feature edit the card has to list the same bodies the chip resolves
 * against, the pre-feature pick layer, because the edit's preview has already
 * consumed the parts the user is picking (a boolean tool, a deleted part).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { BOOLEAN_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import type { Mutation, PartFeature, PartResult } from '@/types/cad'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch' },
  { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  { id: 'bo1', kind: 'boolean', boolean: { operation: 'subtract', target: '', tools: [] } },
]

// The pick layer before the boolean: its two input bodies. The preview during
// the edit holds only the boolean's own result, body_bo1.
const PICK_PARTS: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
}
const PREVIEW_PARTS: Record<string, PartResult> = {
  body_bo1: part('body_bo1', 'bo1'),
}
const LABELS = { body_ex1: 'Base', body_ex2: 'Tool', body_bo1: 'Result' }

function booleanFeature(tools: string[]): PartFeature {
  return {
    id: 'bo1',
    kind: 'boolean',
    label: 'Boolean',
    boolean: { operation: 'subtract', target: '@body_ex1', tools },
  } as unknown as PartFeature
}

interface MountOptions {
  parts: Record<string, PartResult>
  pickParts?: Record<string, PartResult>
  tools?: string[]
  editing?: boolean
  // A test that arms through the chip itself starts unarmed.
  arm?: boolean
}

function mountBoard({ parts, pickParts = {}, tools = [], editing = false, arm = true }: MountOptions) {
  const onMutation = vi.fn()
  const onMutationBatch = vi.fn()
  usePartEditorStore.setState({
    features: FEATURES,
    doc: null,
    visibleFeatures: new Set(FEATURES.map(f => f.id)),
    visibleParts: undefined,
    partLabels: LABELS,
    solveResults: {},
    parts,
    pickParts,
    isRebuilding: false,
    featureTimings: {},
    validation: null,
    otherSketches: {},
  })
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    selectedPicks: new Map(),
    activePickField: null,
    modeStack: [],
    activeTool: null,
    editingFeatureId: editing ? 'bo1' : null,
  })

  const callbacks: PartEditorCallbacks = {
    onToggleSelect: (id) => useEditorState.getState().toggleNormalSelection(id),
    onEnterEditSketch: vi.fn(),
    onExitEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(),
    onExitEditFeature: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onMutation,
    onMutationBatch,
    onSetRollbackPosition: vi.fn(),
  }

  const view = render(
    <PartEditorProvider value={callbacks}>
      <PartDocumentPanel />
      <FeatureEditor
        feature={booleanFeature(tools)}
        onMutation={onMutation}
        onMutationBatch={onMutationBatch}
        features={FEATURES}
        partLabels={LABELS}
        schema={BOOLEAN_SCHEMA}
      />
    </PartEditorProvider>,
  )

  // Arming clears the selection and records that this field names parts, which
  // is what tells the card to show the pick layer behind an edit.
  if (arm) {
    act(() => {
      useEditorState.getState().setActivePickField({ featureId: 'bo1', field: 'tools', multi: true, names: 'body' })
    })
  }

  return { ...view, onMutation, onMutationBatch }
}

function rowNames(): string[] {
  return [...document.querySelectorAll('.parts-list .part-item')].map(
    el => el.querySelector('.part-name')?.textContent ?? '',
  )
}

function row(name: string): HTMLElement {
  const hit = [...document.querySelectorAll('.parts-list .part-item')].find(
    el => el.querySelector('.part-name')?.textContent === name,
  )
  if (!hit) throw new Error(`no parts row named '${name}' (rows: ${rowNames().join(', ')})`)
  return hit as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PartsList  -  a row feeds an armed part chip', () => {
  it('not editing: a row click adds that part to the chip', () => {
    const view = mountBoard({ parts: PICK_PARTS })

    fireEvent.click(row('Tool'))

    expect(view.onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_boolean_tool', featureId: 'bo1', tool: '@body_ex2' } satisfies Mutation,
    ])
  })

  it('editing: the card lists the pick layer, so a part consumed by the preview can still be picked', () => {
    const view = mountBoard({ parts: PREVIEW_PARTS, pickParts: PICK_PARTS, editing: true })

    expect(rowNames()).toEqual(['Base', 'Tool'])
    fireEvent.click(row('Tool'))

    expect(view.onMutationBatch).toHaveBeenCalledWith([
      { type: 'add_boolean_tool', featureId: 'bo1', tool: '@body_ex2' } satisfies Mutation,
    ])
  })

  it('editing: the preview-only body is not offered, and a selection of it is refused', () => {
    const view = mountBoard({ parts: PREVIEW_PARTS, pickParts: PICK_PARTS, editing: true })

    // The edit's own output is not a legal reference: picking it would make the
    // feature depend on itself, so the card must not offer it while picking.
    expect(rowNames()).not.toContain('Result')

    act(() => { useEditorState.getState().toggleNormalSelection('@body_bo1') })

    expect(document.querySelector('.status-message')?.textContent)
      .toBe('Pick refused: can only reference earlier features')
    expect(view.onMutationBatch).not.toHaveBeenCalled()
    // A refusal keeps the field armed so the user can go straight for a valid row.
    expect(useEditorState.getState().activePickField).not.toBeNull()
  })

  it('a second click on a held part row takes it out', () => {
    const view = mountBoard({ parts: PICK_PARTS, tools: ['@body_ex2'] })

    fireEvent.click(row('Tool'))

    expect(view.onMutationBatch).toHaveBeenCalledWith([
      { type: 'remove_boolean_tool', featureId: 'bo1', tool: '@body_ex2' } satisfies Mutation,
    ])
  })

  it('the Tools chip records that it names parts when armed', () => {
    mountBoard({ parts: PICK_PARTS, arm: false })

    // The Tools chip is the second one: the subtract editor arms Target first.
    fireEvent.click(document.querySelectorAll('.feature-pick-chip')[1])

    expect(useEditorState.getState().activePickField).toMatchObject({
      featureId: 'bo1', field: 'tools', names: 'body',
    })
  })
})
