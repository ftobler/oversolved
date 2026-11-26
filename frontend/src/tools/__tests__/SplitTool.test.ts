// The split tool's pure half: which entity and point the hover aims at, what a
// click emits, and why it refuses. The marker component only feeds these the
// store's hover; the viewport plays no part in the decision.

import { describe, it, expect, vi } from 'vitest'
import type { SketchFeature } from '@/types/cad'
import {
  createSplitTool,
  resolveSplitPreview,
  splitClickOutcome,
  splitSnapPoint,
  type SplitHoverInput,
  type SplitPending,
  type SplitPreview,
  type SplitToolContext,
} from '@/tools/SplitTool'

const feature: SketchFeature = {
  id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
  entities: [
    { id: 'h', kind: 'line' }, { id: 'v', kind: 'line' },
    { id: 'c', kind: 'circle' }, { id: 'e', kind: 'ellipse' },
  ],
  initial: {
    h: [0, 0, 10, 0], v: [4, -5, 4, 5],
    c: [20, 0, 3], e: [40, 0, 5, 3, 0],
  },
  constraints: [],
}

const hover = (overrides: Partial<SplitHoverInput>): SplitHoverInput => ({
  activeFeatureId: 'sk',
  feature,
  hoveredSelectionId: null,
  hoveredVertexId: null,
  snapPoint: null,
  cursor: null,
  previousEntityId: null,
  pending: null,
  ...overrides,
})

function context(preview: SplitPreview | null, pending: SplitPending | null = null): SplitToolContext {
  return {
    normalSelection: new Set(),
    hoveredSelectionId: null,
    isPointerDown: false,
    activeFeatureId: 'sk',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: vi.fn(),
    pushMode: vi.fn(),
    popMode: vi.fn(),
    splitPreview: preview,
    splitPending: pending,
    setSplitPending: vi.fn(),
  }
}

const click = (ctx: SplitToolContext) => createSplitTool().handlers.onClick!({ clientX: 0, clientY: 0 }, [0, 0], ctx)

describe('resolveSplitPreview', () => {
  it('aims at the cursor foot on the hovered line', () => {
    const preview = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:h', cursor: [7, 0.2] }))
    expect(preview).toEqual({ featureId: 'sk', entityId: 'h', at: [7, 0], refusal: null, needsSecondPoint: false })
  })

  it('takes a hovered intersection on the curve it was aiming at', () => {
    const preview = resolveSplitPreview(hover({
      hoveredVertexId: 'isect:sk:4:0:h:v',
      snapPoint: [4, 0],
      cursor: [4.1, 0.1],
      previousEntityId: 'h',
    }))
    expect(preview).toMatchObject({ entityId: 'h', at: [4, 0], refusal: null })
  })

  it('ignores a snap point that is not on the aimed curve', () => {
    expect(resolveSplitPreview(hover({
      hoveredVertexId: 'vertex:sk:v:end', snapPoint: [4, 5], previousEntityId: 'h',
    }))).toBeNull()
  })

  it('answers nothing over empty space or another sketch', () => {
    expect(resolveSplitPreview(hover({ cursor: [5, 5] }))).toBeNull()
    expect(resolveSplitPreview(hover({ hoveredSelectionId: 'entity:other:h', cursor: [5, 0] }))).toBeNull()
  })

  it('carries the refusal sentence of a kind that cannot split', () => {
    const preview = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:e', cursor: [45, 0] }))
    expect(preview?.refusal).toMatch(/an ellipse cannot be split/)
  })

  it('refuses a cut on a line end', () => {
    const preview = resolveSplitPreview(hover({
      hoveredVertexId: 'vertex:sk:h:end', snapPoint: [10, 0], previousEntityId: 'h',
    }))
    expect(preview?.refusal).toMatch(/on an end/)
  })

  it('asks a circle for a second point, then plans both', () => {
    const first = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:c', cursor: [23, 0] }))
    expect(first).toMatchObject({ entityId: 'c', needsSecondPoint: true, refusal: null })
    const second = resolveSplitPreview(hover({
      hoveredSelectionId: 'entity:sk:c', cursor: [17, 0],
      pending: { featureId: 'sk', entityId: 'c', at: [[23, 0]] },
    }))
    expect(second).toMatchObject({ needsSecondPoint: false, refusal: null })
  })
})

describe('resolveSplitPreview on a held circle', () => {
  it('refuses a grouped circle on the first point, not after the second click', () => {
    const grouped: SketchFeature = {
      ...feature,
      constraints: [{ id: 'g', kind: 'group', refs: ['$c', '$h'] }],
    }
    const preview = resolveSplitPreview(hover({ feature: grouped, hoveredSelectionId: 'entity:sk:c', cursor: [23, 0] }))
    expect(preview).toMatchObject({ needsSecondPoint: false })
    expect(preview?.refusal).toMatch(/group constraint "g"/)
  })
})

describe('splitSnapPoint', () => {
  it('resolves a vertex against the document and a contact against the inferred set', () => {
    expect(splitSnapPoint('vertex:sk:v:start', feature, [])).toEqual([4, -5])
    expect(splitSnapPoint('isect:sk:4:0:h:v', feature, [{ id: 'isect:sk:4:0:h:v', position: [4, 0] }])).toEqual([4, 0])
    expect(splitSnapPoint('dock:sk:t1', feature, [])).toBeNull()
    expect(splitSnapPoint(null, feature, [])).toBeNull()
  })
})

describe('SplitTool click', () => {
  it('emits one split_entity at the snapped intersection of the hovered line', () => {
    const preview = resolveSplitPreview(hover({
      hoveredVertexId: 'isect:sk:4:0:h:v', snapPoint: [4, 0], previousEntityId: 'h',
    }))
    const ctx = context(preview)
    click(ctx)
    expect(ctx.onMutation).toHaveBeenCalledTimes(1)
    expect(ctx.onMutation).toHaveBeenCalledWith({ type: 'split_entity', featureId: 'sk', entityId: 'h', at: [[4, 0]] })
  })

  it('emits nothing without a hovered entity', () => {
    const ctx = context(resolveSplitPreview(hover({ cursor: [3, 3] })))
    click(ctx)
    expect(ctx.onMutation).not.toHaveBeenCalled()
  })

  it('emits nothing on a refused kind and reports the refusal', () => {
    const preview = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:e', cursor: [45, 0] }))
    const outcome = splitClickOutcome(preview, null)
    expect(outcome.kind).toBe('refused')
    const ctx = context(preview)
    click(ctx)
    expect(ctx.onMutation).not.toHaveBeenCalled()
  })

  it('holds a circle\'s first point and cuts on the second click', () => {
    const first = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:c', cursor: [23, 0] }))
    const ctx1 = context(first)
    click(ctx1)
    expect(ctx1.onMutation).not.toHaveBeenCalled()
    expect(ctx1.setSplitPending).toHaveBeenCalledWith({ featureId: 'sk', entityId: 'c', at: [[23, 0]] })

    const pending: SplitPending = { featureId: 'sk', entityId: 'c', at: [[23, 0]] }
    const second = resolveSplitPreview(hover({ hoveredSelectionId: 'entity:sk:c', cursor: [17, 0], pending }))
    const ctx2 = context(second, pending)
    click(ctx2)
    expect(ctx2.onMutation).toHaveBeenCalledTimes(1)
    const m = vi.mocked(ctx2.onMutation!).mock.calls[0][0]
    expect(m).toMatchObject({ type: 'split_entity', featureId: 'sk', entityId: 'c' })
    const at = (m as { at: [number, number][] }).at
    expect(at[0]).toEqual([23, 0])
    expect(at[1][0]).toBeCloseTo(17, 12)
    expect(at[1][1]).toBeCloseTo(0, 12)
    expect(ctx2.setSplitPending).toHaveBeenCalledWith(null)
  })
})
