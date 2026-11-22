// @vitest-environment jsdom
//
// A mutation the appliers refuse (a projection source that cannot resolve, a
// reorder that would invert a projection's order) must not crash the editor:
// the funnel reports it through the refusal toast and leaves the document as it
// was. The session path itself is covered by the applier suites; this pins the
// UI adapter's answer.
import { describe, it, expect, vi } from 'vitest'
import { renderHookStrict } from '@/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { docRef } from './usePartDoc.undoHarness'
import type { PartDoc } from '@/types/cad'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

function projectionDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      { id: 'Front', kind: 'plane' },
      { id: 'Right', kind: 'plane' },
      {
        id: 'skA', kind: 'sketch', plane: '@builtin_plane_top',
        entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 10, 0] },
      },
      {
        id: 'skB', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [2, 2] },
        constraints: [{ id: 'proj_p1', kind: 'projection', target: '$p1', source: '@skA/l1' }],
      },
    ],
  }
}

describe('usePartDoc reports an applier refusal', () => {
  it('returns a failure and calls the refusal reporter for a hostile projection source', () => {
    const refusals: string[] = []
    const { result } = renderHookStrict(() => usePartDoc('u', {
      solveOnLoad: false,
      onRefusal: message => refusals.push(message),
    }))
    docRef.current = projectionDoc()
    const before = structuredClone(docRef.current)

    const outcome = result.current.handleMutation({
      type: 'add_projected_entity', featureId: 'skA', kind: 'point', source: '@skA/l1',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'refused' })
    expect((outcome as { message: string }).message).toContain('cannot project its own entity')
    expect(refusals).toEqual([expect.stringContaining('cannot project its own entity')])
    expect(docRef.current).toEqual(before)
  })

  it('refuses a reorder that would invert a projection and keeps the feature order', () => {
    const refusals: string[] = []
    const { result } = renderHookStrict(() => usePartDoc('u', {
      solveOnLoad: false,
      onRefusal: message => refusals.push(message),
    }))
    docRef.current = projectionDoc()
    const before = docRef.current.features!.map(feature => feature.id)

    const outcome = result.current.handleMutation({
      type: 'reorder_features', featureId: 'skA', after: 'skB',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'refused' })
    expect(refusals).toEqual([expect.stringContaining('cannot move skA below skB')])
    expect(docRef.current.features!.map(feature => feature.id)).toEqual(before)
  })

  it('reports a pattern source edit on a row that is not a pattern', () => {
    // The chip's applier used to warn and return, which the editor cannot show:
    // this pins the toast the click now reaches instead of a dead control.
    const refusals: string[] = []
    const { result } = renderHookStrict(() => usePartDoc('u', {
      solveOnLoad: false,
      onRefusal: message => refusals.push(message),
    }))
    docRef.current = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5 } }],
    }
    const before = structuredClone(docRef.current)

    const outcome = result.current.handleMutation({
      type: 'add_pattern_source', featureId: 'ex1', sourceFeature: '@rv1',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'refused' })
    expect(refusals).toEqual([expect.stringContaining('not a pattern')])
    expect(docRef.current).toEqual(before)
  })

  // The reported bug: an invalid variable rename used to return quietly, so the
  // dialog closed and the tree kept the old name with no message. The applier now
  // throws the same sentence the dialog hint shows.
  it('refuses an invalid variable rename, toasts the sentence and records no undo entry', () => {
    const refusals: string[] = []
    const { result } = renderHookStrict(() => usePartDoc('u', {
      solveOnLoad: false,
      onRefusal: message => refusals.push(message),
    }))
    docRef.current = {
      version: 1,
      kind: 'part',
      features: [{ id: 'v1', kind: 'variable', label: 'width', variable: { expression: '10' } }],
    }
    const before = structuredClone(docRef.current)

    const outcome = result.current.handleMutation({
      type: 'rename_feature', featureId: 'v1', label: 'my-var',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'refused' })
    expect((outcome as { message: string }).message).toBe(
      '"my-var" is not a valid variable name: use letters, digits and _ only '
        + '(a - reads as minus in an expression). Try "my_var".',
    )
    expect(refusals).toEqual([expect.stringContaining('is not a valid variable name')])
    expect(docRef.current).toEqual(before)
    expect(result.current.undoStack).toHaveLength(0)
  })
})
