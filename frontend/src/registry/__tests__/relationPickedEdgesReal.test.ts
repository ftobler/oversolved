// @vitest-environment node
//
// The real-solve half of feature->picked-edges. A modifier that is refused must
// still show where it was meant to apply, so the hint is exactly its picks that
// the shown solve still publishes.
//
// The refusal here is a radius that cannot fit into its faces, not the consumed
// end face that feature/bug-fillet-end-cap-sliver diagnoses (and now builds via
// a prism cut). A 10 x 10 x 5 box filleted at r20 cannot consume faces 10 wide,
// so the width path names the geometry and the feature stays a refusal.
//
// Part 2 uses two bodies: the kernel applies one group and refuses the other,
// which is the partial case where the applied pick has already been consumed.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../kernel/occ/loadOcc'
import { SharedHarness } from '../../kernel/occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { PART_RULES, buildPartRelationCtx } from '@/registry/relationRuleRegistry'
import { hintDrivers, relatedHints } from '@/picking/relationHint'
import type { BodyResult, PartFeature } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

function rectSketch(id: string, size: number, x0 = 0, y0 = 0): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_top',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [x0, y0, x0 + size, y0], right: [x0 + size, y0, x0 + size, y0 + size],
      top: [x0 + size, y0 + size, x0, y0 + size], left: [x0, y0 + size, x0, y0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: size },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: size },
    ],
  }
}

/** The four upright edges of one extruded rectangle, in the build's own query
 *  spelling (the query index and the edge data are not aligned). */
function uprightEdges(queries: string[], sketchId: string): string[] {
  const token = new RegExp(`@${sketchId}/`, 'g')
  return queries.filter((q) => (q.match(token) ?? []).length === 2 && /@cls_z/.test(q))
}

describe.skipIf(!oc || !solveBytes)('feature->picked-edges (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('a refused fillet hints exactly its four picks, every one still on the body', () => {
    const spec: { features: Dict[] } = { features: [
      rectSketch('sk1', 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const base = h.run(spec)
    const picks = uprightEdges((h.body(base, 'body_ex1').edge_queries as string[]) ?? [], 'sk1')
    expect(picks).toHaveLength(4)

    spec.features.push({ id: 'fi1', kind: 'fillet', fillet: { edges: picks, radius: 20 } })
    const result = h.run(spec)
    const fillet = h.res(result, 'fi1')
    // Still a refusal, and the width path's words: two picked borders on one
    // face halve the width the blend may use, so r20 is past the limit.
    expect(fillet.status).toBe('exception')
    const message = String(fillet.exception ?? '')
    expect(message).toContain('consumes the 10 face between the picked edges')
    expect(message).not.toContain('end face')

    const shown = result.bodies as Record<string, BodyResult>
    const shownEdges = new Set(shown.body_ex1.edge_queries ?? [])
    for (const q of picks) expect(shownEdges.has(q)).toBe(true)

    const hints = relatedHints(
      hintDrivers(new Set(['@fi1'])),
      PART_RULES,
      buildPartRelationCtx(spec.features as unknown as PartFeature[], shown),
    )
    expect(hints.picked).toEqual(new Set(picks))
    expect(hints.failedPicks.size).toBe(0)
  }, 180_000)

  it('a single pick refused for its adjacent face is named and still hinted', () => {
    // One upright edge: its adjacent face is 10 wide and the radius may use the
    // whole of it, so the message names the width directly.
    const spec: { features: Dict[] } = { features: [
      rectSketch('sk1', 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const base = h.run(spec)
    const pick = uprightEdges((h.body(base, 'body_ex1').edge_queries as string[]) ?? [], 'sk1')[0]
    spec.features.push({ id: 'fi1', kind: 'fillet', fillet: { edges: [pick], radius: 20 } })
    const result = h.run(spec)
    const fillet = h.res(result, 'fi1')
    expect(fillet.status).toBe('exception')
    expect(String(fillet.exception ?? '')).toContain('consumes the 10 adjacent face')

    const shown = result.bodies as Record<string, BodyResult>
    const hints = relatedHints(
      hintDrivers(new Set(['@fi1'])),
      PART_RULES,
      buildPartRelationCtx(spec.features as unknown as PartFeature[], shown),
    )
    expect(hints.picked).toEqual(new Set([pick]))
  }, 180_000)

  it('a partial blend hints only the refused pick: the applied one was consumed', () => {
    // Two bodies, one wide enough for r5 and one that is not. The kernel applies
    // the first group and refuses the second, so the result is partial and names
    // the refused pick in failed_edges.
    const spec: { features: Dict[] } = { features: [
      rectSketch('sk1', 40, 0, 0),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
      rectSketch('sk2', 4, 60, 0),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const base = h.run(spec)
    const wide = uprightEdges((h.body(base, 'body_ex1').edge_queries as string[]) ?? [], 'sk1')
    const narrow = uprightEdges((h.body(base, 'body_ex2').edge_queries as string[]) ?? [], 'sk2')
    expect(wide.length).toBe(4)
    expect(narrow.length).toBe(4)

    spec.features.push({ id: 'fi1', kind: 'fillet', fillet: { edges: [wide[0], narrow[0]], radius: 5 } })
    const result = h.run(spec)
    const fillet = h.res(result, 'fi1')
    expect(fillet.status).toBe('partial')
    expect(fillet.failed_edges).toEqual([narrow[0]])

    const shown = result.bodies as Record<string, BodyResult>
    // The blend consumed the applied pick but left the refused one in place.
    expect(shown.body_ex1.edge_queries ?? []).not.toContain(wide[0])
    expect(shown.body_ex2.edge_queries ?? []).toContain(narrow[0])

    const hints = relatedHints(
      hintDrivers(new Set(['@fi1'])),
      PART_RULES,
      buildPartRelationCtx(
        spec.features as unknown as PartFeature[],
        shown,
        undefined,
        new Set(fillet.failed_edges as string[]),
      ),
    )
    expect(hints.picked.size).toBe(0)
    expect(hints.failedPicks).toEqual(new Set([narrow[0]]))
  }, 180_000)
})
