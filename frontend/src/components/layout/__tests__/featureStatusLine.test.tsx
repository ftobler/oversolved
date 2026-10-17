/**
 * The feature status model, end to end through the real sidebar: one mark per
 * feature (featureFailure), drawn the same way in the tree row and as the
 * first line of the open editor, for every kind. These pin the few states a
 * user can observe so no editor grows its own failure display again:
 *   - healthy: no tint, no line
 *   - error: red row, red line, same words
 *   - warning (partial result or solver fallback): amber row, amber line
 *   - per-pick verdicts of a partial result marked on the chips
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature, BodyResult } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { PartEditorProvider, type PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { useEditorState } from '@/hooks/useEditorState'

function callbacks(): PartEditorCallbacks {
  return {
    onToggleSelect: vi.fn(), onEnterEditSketch: vi.fn(), onExitEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(), onExitEditFeature: vi.fn(), onEditCommit: vi.fn(),
    onEditCancel: vi.fn(), onToggleVisibility: vi.fn(), onRightClick: vi.fn(),
    onMutation: vi.fn(), onSetRollbackPosition: vi.fn(),
  }
}

/** Render the sidebar with `feature` open in its editor. */
function renderEditing(feature: PartFeature, solveResults: Record<string, unknown>, bodies: Record<string, BodyResult> = {}) {
  usePartEditorStore.setState({
    features: [feature], visibleFeatures: new Set([feature.id]), doc: { version: 1, kind: 'part', features: [feature] } as never,
    visibleBodies: new Set(), partLabels: {}, solveResults, bodies, isRebuilding: false, featureTimings: {},
  })
  useEditorState.setState({
    editingFeatureId: feature.id, rollbackPosition: null,
    normalSelection: new Set(), chipOwnedSelection: new Set(), activePickField: null, modeStack: [],
  })
  return render(<PartEditorProvider value={callbacks()}><Sidebar /></PartEditorProvider>)
}

/** The row name and the editor line must agree on level and words. */
function expectSameMark(level: 'error' | 'warning', message: string) {
  const name = document.querySelector('.feature-name')!
  expect(name.classList.contains(`feature-name-${level}`)).toBe(true)
  expect(name.getAttribute('title')).toBe(message)
  const line = document.querySelector('.feature-item .status-message')!
  expect(line).not.toBeNull()
  expect(line.classList.contains(`status-message--${level}`)).toBe(true)
  expect(line.textContent).toBe(message)
}

const EXTRUDE: PartFeature = { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 10 } } as unknown as PartFeature

beforeEach(() => {
  useEditorState.setState({ editingFeatureId: null })
})

describe('feature status line', () => {
  it('a healthy feature shows no tint and no line', () => {
    renderEditing(EXTRUDE, { ex1: { status: 'ok', body_id: 'body_ex1' } })
    expect(document.querySelector('.feature-name')!.className).not.toMatch(/feature-name-(error|warning)/)
    expect(document.querySelector('.status-message')).toBeNull()
  })

  it('an error reads the same in the row and at the top of the editor', () => {
    renderEditing(EXTRUDE, { ex1: { status: 'exception', exception: 'sketch not found' } })
    expectSameMark('error', 'sketch not found')
  })

  it('a solver fallback on a good solve is a warning in both places', () => {
    // Dropped before it reached the UI; now the one trace of the fallback.
    renderEditing(EXTRUDE, { ex1: { status: 'ok', body_id: 'body_ex1', solver_warning: "up_to target '?x' did not resolve; used blind distance" } })
    expectSameMark('warning', "up_to target '?x' did not resolve; used blind distance")
  })

  it('the line is drawn for kinds without a schema editor too', () => {
    // Sketch plane, plane and STEP import each have a bespoke editor body;
    // the line comes from the host, so none of them can miss it.
    for (const feature of [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_top' },
      { id: 'pl1', kind: 'plane', definition: { mode: 'offset' } },
      { id: 'imp1', kind: 'import_step', file_id: 'f1' },
    ] as unknown as PartFeature[]) {
      const { unmount } = renderEditing(feature, { [feature.id]: { status: 'exception', exception: `${feature.kind} broke` } })
      expectSameMark('error', `${feature.kind} broke`)
      unmount()
    }
  })

  it('a partial result warns and marks the picks that did not apply on the chips', () => {
    const fillet = { id: 'fi1', kind: 'fillet', fillet: { edges: ['?1;a', '?2;b', '?3;c'], radius: 1 } } as unknown as PartFeature
    renderEditing(fillet, {
      fi1: {
        status: 'partial', body_id: 'body_ex1', exception: '2 edge(s) could not be applied',
        unresolved_edges: ['?1;a'], failed_edges: ['?2;b'],
      },
    })
    expectSameMark('warning', '2 edge(s) could not be applied')
    const items = [...document.querySelectorAll('.feature-pick-chip-item')]
    expect(items).toHaveLength(3)
    expect(items[0].classList.contains('unresolved')).toBe(true)
    expect(items[1].classList.contains('failed')).toBe(true)
    expect(items[2].className).not.toMatch(/unresolved|failed/)
  })

  it('a click on the status line does not reach the row', () => {
    // The row's onClick toggles `@<feature>` into the selection, which an
    // armed pick field would consume (and refuse) as a pick.
    const cb = callbacks()
    usePartEditorStore.setState({
      features: [EXTRUDE], visibleFeatures: new Set(['ex1']), doc: null, visibleBodies: new Set(), partLabels: {},
      solveResults: { ex1: { status: 'exception', exception: 'sketch not found' } }, bodies: {}, isRebuilding: false, featureTimings: {},
    })
    useEditorState.setState({ editingFeatureId: 'ex1', normalSelection: new Set(), activePickField: null, modeStack: [] })
    render(<PartEditorProvider value={cb}><Sidebar /></PartEditorProvider>)
    fireEvent.click(document.querySelector('.status-message')!)
    expect(cb.onToggleSelect).not.toHaveBeenCalled()
  })

  it('a closed editor shows the mark only on the row', () => {
    renderEditing(EXTRUDE, { ex1: { status: 'exception', exception: 'sketch not found' } })
    expect(screen.getAllByText('sketch not found')).toHaveLength(1)
    act(() => { useEditorState.setState({ editingFeatureId: null }) })
    expect(document.querySelector('.status-message')).toBeNull()
    expect(document.querySelector('.feature-name')!.getAttribute('title')).toBe('sketch not found')
  })
})
