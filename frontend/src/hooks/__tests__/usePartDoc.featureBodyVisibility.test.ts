// The sweep's tree eye is only useful if it reaches the geometry. This drives
// the real mutation handler and the real undo stack, then asks the body
// renderer (no Viewport) what it would draw: the sweep's body leaves the
// visible set, and undo brings it back. Feature visibility stays a document
// write; no per-body mutation is recorded.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import type { PartDoc, BodyResult } from '@/types/cad'
import { docVisibleFeatureIds } from '@/utils/featureVisibility'
import { getBodiesToRender } from '@/utils/bodyRender'
import { docRef, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

const sweptDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch' },
    { id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$hx1' } },
  ],
} as unknown as PartDoc)

const bodies: Record<string, BodyResult> = {
  body_sw1: {
    id: 'body_sw1',
    created_by: 'sw1',
    modified_by: [],
    mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
  } as unknown as BodyResult,
}

// What the viewport would draw, derived the same way the page derives it: the
// document rule names the visible features, the body renderer reads them.
const drawnBodies = () => {
  const features = docRef.current.features ?? []
  return getBodiesToRender(bodies, features, undefined, undefined, docVisibleFeatureIds(features))
}

describe('feature visibility of a sweep', () => {
  beforeEach(() => {
    resetHarness()
    docRef.current = sweptDoc()
  })

  it('hides the bodies the sweep made, and undo restores them', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    expect(drawnBodies()[0].visible).toBe(true)

    act(() => {
      result.current.handleMutation({ type: 'set_feature_visibility', featureId: 'sw1', visible: false })
    })

    const sweep = docRef.current.features!.find(f => f.id === 'sw1') as { visible?: boolean }
    expect(sweep.visible).toBe(false)
    expect(drawnBodies()[0].visible).toBe(false)
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    expect(drawnBodies()[0].visible).toBe(true)
    expect(result.current.redoStack).toHaveLength(1)
  })

  it('removes the flag again on show, so a hidden sweep survives a save round trip as a flag only', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    act(() => {
      result.current.handleMutation({ type: 'set_feature_visibility', featureId: 'sw1', visible: false })
    })
    act(() => {
      result.current.handleMutation({ type: 'set_feature_visibility', featureId: 'sw1', visible: true })
    })
    const sweep = docRef.current.features!.find(f => f.id === 'sw1') as { visible?: boolean }
    expect('visible' in sweep).toBe(false)
    expect(drawnBodies()[0].visible).toBe(true)
    // Hide and show are two real edits, not an idempotent no-op.
    expect(result.current.undoStack).toHaveLength(2)
  })
})
