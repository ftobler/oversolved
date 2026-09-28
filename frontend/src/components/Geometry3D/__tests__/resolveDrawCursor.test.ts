import { describe, it, expect } from 'vitest'
import { computeDrawClick, resolveDrawCursor } from '@/components/Geometry3D/drawLogic'
import type { DrawSnapState } from '@/components/Geometry3D/drawLogic'
import type { Entity, Mutation } from '@/types/cad'

// The preview draws to resolveDrawCursor's point and the commit writes
// computeDrawClick's; these tests pin that both read the snap state the same way.

const FEATURE = 'S1'

const emptySnap = (): DrawSnapState => ({
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredSelectionId: null,
  drawSnapRefs: [],
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
})

const onVertex = (id: string, at: [number, number]): DrawSnapState => ({
  ...emptySnap(),
  hoveredVertexId: id,
  hoveredVertexPosition: at,
  hoveredSnapKind: 'vertex',
})

const horizontalFrom = (anchor: [number, number]): DrawSnapState => ({
  ...emptySnap(),
  alignmentSnapPoint: anchor,
  alignmentSnapKind: 'kinda_horizontal',
})

const LINE: Record<string, Entity> = {
  L1: { start: [0, 0], end: [10, 0] } as Entity,
}

function params(m: Mutation): number[] {
  if (m.type !== 'add_entity' && m.type !== 'add_entity_with_constraint') {
    throw new Error(`unexpected mutation ${m.type}`)
  }
  return m.params
}

describe('resolveDrawCursor', () => {
  it('returns the raw cursor when nothing is snapped', () => {
    expect(resolveDrawCursor('line', [[0, 0]], [3, 4], emptySnap())).toEqual([3, 4])
  })

  it('moves a line end onto the hovered vertex', () => {
    const snap = onVertex('vertex:S1:V1:end', [5, 5])
    expect(resolveDrawCursor('line', [[0, 0]], [5.2, 4.9], snap)).toEqual([5, 5])
  })

  it('projects a line end onto the alignment axis', () => {
    expect(resolveDrawCursor('line', [[0, 2]], [7, 2.3], horizontalFrom([0, 2]))).toEqual([7, 2])
  })

  it('moves the cursor onto the foot on a hovered curve', () => {
    const snap: DrawSnapState = { ...emptySnap(), hoveredSelectionId: 'entity:S1:L1' }
    expect(resolveDrawCursor('circle', [[0, 5]], [4, 3], snap, LINE)).toEqual([4, 0])
  })

  it.each(['rect', 'center_rect', 'ngon'])(
    '%s second click ignores the alignment snap, as its commit does',
    (tool) => {
      expect(resolveDrawCursor(tool, [[0, 2]], [7, 2.3], horizontalFrom([0, 2]))).toEqual([7, 2.3])
    },
  )

  it.each(['rect', 'center_rect', 'ngon'])(
    '%s second click still follows a vertex snap',
    (tool) => {
      const snap = onVertex('vertex:S1:V1:end', [5, 5])
      expect(resolveDrawCursor(tool, [[0, 0]], [5.2, 4.9], snap)).toEqual([5, 5])
    },
  )
})

describe('resolveDrawCursor matches the committed coordinate', () => {
  const snaps: [string, DrawSnapState, Record<string, Entity> | undefined][] = [
    ['no snap', emptySnap(), undefined],
    ['vertex snap', onVertex('vertex:S1:V1:end', [5, 5]), undefined],
    ['alignment snap', horizontalFrom([0, 2]), undefined],
    ['path snap', { ...emptySnap(), hoveredSelectionId: 'entity:S1:L1' }, LINE],
  ]

  it.each(snaps)('line end with %s', (_label, snap, sketch) => {
    const raw: [number, number] = [5.2, 4.9]
    const cursor = resolveDrawCursor('line', [[0, 2]], raw, snap, sketch)
    const click = computeDrawClick('line', [[0, 2]], raw, snap, FEATURE, () => 'L9', sketch)
    expect(params(click.mutations[0]).slice(2, 4)).toEqual(cursor)
  })

  // The compound tools' second click commits p1 / corner; the alignment snap
  // row is the case where both sides must agree on falling back to raw.
  const secondCorner = (m: Mutation): [number, number] => {
    if (m.type === 'add_rect') return m.p1
    if (m.type === 'add_center_rect' || m.type === 'add_ngon') return m.corner
    throw new Error(`unexpected mutation ${m.type}`)
  }
  const compound = ['rect', 'center_rect', 'ngon'].flatMap(tool =>
    snaps.map(([label, snap, sketch]) => [tool, label, snap, sketch] as const))

  it.each(compound)('%s second click with %s', (tool, _label, snap, sketch) => {
    const raw: [number, number] = [5.2, 4.9]
    const cursor = resolveDrawCursor(tool, [[0, 2]], raw, snap, sketch)
    const click = computeDrawClick(tool, [[0, 2]], raw, snap, FEATURE, () => 'R9', sketch)
    expect(click.mutations).toHaveLength(1)
    expect(secondCorner(click.mutations[0])).toEqual(cursor)
  })

  it.each(snaps)('circle radius point with %s', (_label, snap, sketch) => {
    const raw: [number, number] = [5.2, 4.9]
    const cursor = resolveDrawCursor('circle', [[0, 2]], raw, snap, sketch)
    const click = computeDrawClick('circle', [[0, 2]], raw, snap, FEATURE, () => 'C9', sketch)
    expect(params(click.mutations[0])[2]).toBeCloseTo(Math.hypot(cursor[0] - 0, cursor[1] - 2), 12)
  })
})
