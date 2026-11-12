import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyResult, MateFeature, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import {
  ALL_RELATION_RULES,
  ASSEMBLY_RULES,
  PART_RULES,
  buildAssemblyRelationCtx,
  buildPartRelationCtx,
} from '@/registry/relationRuleRegistry'
import { hintDrivers, relatedHints } from '@/picking/relationHint'
import { EMPTY_RELATION_SET } from '@/picking/relationHint'

const faceQuery = (creator: string, body = 'body_ex1') =>
  makeAncestryQuery(['@u|uuid-' + creator, `@${creator}`, `@${body}`], 'flatface')
const edgeQuery = (creator: string, body = 'body_ex1') =>
  makeAncestryQuery(['@u|edge-' + creator, `@${creator}`, `@${body}`], 'straightedge')

const extrude = (id: string, sketch: string): PartFeature => ({
  id,
  kind: 'extrude',
  extrude: { sketch, distance: 10, direction: 'normal' },
})

/** A named edge pick on a body, distinct per tag. */
const pickEdge = (tag: string, body = 'body_ex1') =>
  makeAncestryQuery(['@u|pick-' + tag, `@ex1`, `@${body}`], 'straightedge')
/** A named face pick on a body, distinct per tag. */
const pickFace = (tag: string, body = 'body_ex1') =>
  makeAncestryQuery(['@u|pick-' + tag, `@ex1`, `@${body}`], 'flatface')

const fillet = (id: string, edges: string[], radius = 1): PartFeature => ({
  id,
  kind: 'fillet',
  fillet: { edges, radius },
})
const chamfer = (id: string, edges: string[]): PartFeature => ({
  id,
  kind: 'chamfer',
  chamfer: { edges, distance: 1 },
})
const shell = (id: string, faces: string[]): PartFeature => ({
  id,
  kind: 'shell',
  shell: { faces, thickness: 1 },
})

function body(id: string, createdBy: string, overrides: Partial<BodyResult> = {}): BodyResult {
  return { id, created_by: createdBy, modified_by: [], ...overrides }
}

function partHints(
  selection: string[],
  features: PartFeature[],
  bodies: Record<string, BodyResult> = {},
  activeFeatureIds?: ReadonlySet<string>,
  failedPicks: ReadonlySet<string> = new Set(),
) {
  return relatedHints(
    hintDrivers(selection),
    PART_RULES,
    buildPartRelationCtx(features, bodies, activeFeatureIds, failedPicks),
  )
}

describe('relation rule registry coverage', () => {
  it('rule ids are unique across both editors', () => {
    const ids = ALL_RELATION_RULES.map(rule => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every rule has its own describe block in this test file', () => {
    // A rule added to the table without a test fails here rather than shipping
    // as an unexamined relation.
    const source = readFileSync(join(__dirname, 'relationRuleRegistry.test.ts'), 'utf8')
    for (const rule of ALL_RELATION_RULES) {
      expect(source, `missing describe('${rule.id}')`).toContain(`describe('${rule.id}'`)
    }
  })

  it('every rule is enabled and shows somewhere', () => {
    for (const rule of ALL_RELATION_RULES) {
      expect(rule.enabled, rule.id).toBe(true)
      expect(rule.show.length, rule.id).toBeGreaterThan(0)
    }
  })

  it('every rule declares the editor whose table holds it', () => {
    for (const rule of PART_RULES) expect(rule.editor, rule.id).toBe('part')
    for (const rule of ASSEMBLY_RULES) expect(rule.editor, rule.id).toBe('assembly')
  })
})

describe('face->creator', () => {
  const features = [extrude('ex1', '@sk1'), extrude('cut1', '@sk2')]
  const bodies = {
    b1: body('b1', 'ex1', {
      mesh: { vertices: [], faces: [], face_queries: [faceQuery('ex1')], face_created_by: ['ex1'] },
    }),
    b2: body('b2', 'cut1', {
      edges: [],
      edge_queries: [edgeQuery('cut1')],
      edge_created_by: ['cut1'],
    }),
  }

  it('a selected face marks the feature that created it', () => {
    const hints = partHints([faceQuery('ex1')], features, bodies)
    expect(hints.tree).toEqual(new Set(['@ex1']))
    expect(hints.viewport).toEqual(new Set())
  })

  it('a face and an edge of two features mark both', () => {
    const hints = partHints([faceQuery('ex1'), edgeQuery('cut1')], features, bodies)
    expect(hints.tree).toEqual(new Set(['@ex1', '@cut1']))
  })

  it('a query absent from the index relates nothing', () => {
    expect(partHints([faceQuery('ghost')], features, {}).tree.size).toBe(0)
  })

  it('a face query a body owns answers every recorded creator', () => {
    const shared = faceQuery('ex1')
    const bodies = {
      b1: body('b1', 'ex1', {
        mesh: { vertices: [], faces: [], face_queries: [shared], face_created_by: ['ex1'] },
      }),
      b2: body('b2', 'cut1', {
        mesh: { vertices: [], faces: [], face_queries: [shared], face_created_by: ['cut1'] },
      }),
    }
    expect(new Set(partHints([shared], features, bodies).tree)).toEqual(new Set(['@ex1', '@cut1']))
  })
})

describe('edge->creator', () => {
  it('a selected edge marks its creating feature through edge_created_by', () => {
    const bodies = {
      b1: body('b1', 'ex1', {
        edges: [],
        edge_queries: [edgeQuery('fil1')],
        edge_created_by: ['fil1'],
      }),
    }
    expect(partHints([edgeQuery('fil1')], [extrude('ex1', '@sk1'), extrude('fil1', '@sk1')], bodies).tree)
      .toEqual(new Set(['@fil1']))
  })
})

describe('feature->faces', () => {
  it('a solid feature points the viewport at itself, not at a tree row', () => {
    const hints = partHints(['@ex1'], [extrude('ex1', '@sk1')])
    expect(hints.viewport).toEqual(new Set(['ex1']))
    expect(hints.tree.size).toBe(0)
  })

  it('a rolled-back feature hints nothing', () => {
    const hints = partHints(['@ex1'], [extrude('ex1', '@sk1')], {}, new Set())
    expect(hints.viewport.size).toBe(0)
  })
})

describe('feature->picked-edges', () => {
  const q1 = pickEdge('one')
  const q2 = pickEdge('two')
  const q3 = pickEdge('other')
  const features: PartFeature[] = [extrude('ex1', '@sk1'), fillet('fi1', [q1, q2])]
  const bodyWith = (queries: string[], createdBy = 'ex1') => ({
    body_ex1: body('body_ex1', createdBy, { edges: [], edge_queries: queries }),
  })
  const allPicks = bodyWith([q1, q2, q3])

  it('a failed fillet draws every pick that still exists in the shown solve', () => {
    const hints = partHints(['@fi1'], features, allPicks)
    expect(hints.picked).toEqual(new Set([q1, q2]))
    expect(hints.failedPicks.size).toBe(0)
    // The rule is viewport-only: a pick never marks a tree row.
    expect(hints.tree.size).toBe(0)
  })

  it('a pick the last solve refused goes to the failure colour', () => {
    // A whole-feature refusal names no failed_edges (the kernel throws before it
    // can), so this is the partial case: the kernel named the pick it skipped.
    const hints = partHints(['@fi1'], features, allPicks, undefined, new Set([q2]))
    expect(hints.picked).toEqual(new Set([q1]))
    expect(hints.failedPicks).toEqual(new Set([q2]))
  })

  it('a built fillet consumed its picks: no pick hint, its created faces stay the answer', () => {
    // The blend replaced both picked edges, so neither query exists any more.
    // `feature->faces` is what a built feature shows, not this rule.
    const hints = partHints(['@fi1'], features, bodyWith([q3], 'fi1'))
    expect(hints.picked.size).toBe(0)
    expect(hints.failedPicks.size).toBe(0)
    expect(hints.viewport).toEqual(new Set(['fi1']))
  })

  it('a partial fillet draws only the pick that refused; the applied one is gone', () => {
    const partial = bodyWith([q2, q3])
    const hints = partHints(['@fi1'], features, partial, undefined, new Set([q2]))
    expect(hints.picked.size).toBe(0)
    expect(hints.failedPicks).toEqual(new Set([q2]))
  })

  it('a stale pick absent from every shown body draws nothing', () => {
    const hints = partHints(['@fi1'], features, bodyWith([q3]))
    expect(hints.picked.size).toBe(0)
    expect(hints.failedPicks.size).toBe(0)
  })

  it('a rolled-back fillet hints nothing', () => {
    const hints = partHints(['@fi1'], features, allPicks, new Set(['ex1']))
    expect(hints.picked.size).toBe(0)
  })

  it('a chamfer row draws its picked edges the same way', () => {
    const chamfers: PartFeature[] = [extrude('ex1', '@sk1'), chamfer('ch1', [q1])]
    expect(partHints(['@ch1'], chamfers, allPicks).picked).toEqual(new Set([q1]))
  })

  it('a feature that picks no primitive draws no pick hint', () => {
    expect(partHints(['@ex1'], features, allPicks).picked.size).toBe(0)
  })

  it('a single-string pick list from a hand-edited doc degrades to that one pick', () => {
    const odd = { id: 'fi1', kind: 'fillet', fillet: { edges: q1, radius: 1 } } as unknown as PartFeature
    expect(partHints(['@fi1'], [extrude('ex1', '@sk1'), odd], allPicks).picked).toEqual(new Set([q1]))
  })
})

describe('feature->picked-faces', () => {
  const f1 = pickFace('one')
  const f2 = pickFace('two')
  const f3 = pickFace('other')
  const features: PartFeature[] = [extrude('ex1', '@sk1'), shell('sh1', [f1, f2])]
  const bodyWith = (queries: string[]) => ({
    body_ex1: body('body_ex1', 'ex1', {
      mesh: { vertices: [], faces: [], face_queries: queries },
    }),
  })
  const allFaces = bodyWith([f1, f2, f3])

  it('a failed shell draws the open faces it still has', () => {
    expect(partHints(['@sh1'], features, allFaces).picked).toEqual(new Set([f1, f2]))
  })

  it('a refused face pick uses the failure colour', () => {
    const hints = partHints(['@sh1'], features, allFaces, undefined, new Set([f1]))
    expect(hints.picked).toEqual(new Set([f2]))
    expect(hints.failedPicks).toEqual(new Set([f1]))
  })

  it('a built shell consumed its openings: no face pick hint', () => {
    expect(partHints(['@sh1'], features, bodyWith([f3])).picked.size).toBe(0)
  })

  it('move face and delete face rows draw their face picks', () => {
    const movers: PartFeature[] = [
      extrude('ex1', '@sk1'),
      { id: 'mf1', kind: 'move_face', move_face: { faces: [f1], distance: 2 } },
      { id: 'df1', kind: 'delete_face', delete_face: { faces: [f2] } },
    ]
    expect(partHints(['@mf1'], movers, allFaces).picked).toEqual(new Set([f1]))
    expect(partHints(['@df1'], movers, allFaces).picked).toEqual(new Set([f2]))
  })
})

describe('feature->consumed-sketch', () => {
  it('an extrude row marks its sketch row', () => {
    const features: PartFeature[] = [extrude('ex1', '@sk1'), { id: 'sk1', kind: 'sketch' }]
    const hints = partHints(['@ex1'], features)
    expect(hints.tree).toEqual(new Set(['@sk1']))
    expect(hints.viewport).toEqual(new Set(['ex1', 'sk1']))
  })

  it('a sweep row marks its profile and its helix path', () => {
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'hx1', kind: 'helix', helix: {} },
      { id: 'sw1', kind: 'sweep', sweep: { sketch: '@sk1', path: '@hx1' } },
    ]
    expect(partHints(['@sw1'], features).tree).toEqual(new Set(['@sk1', '@hx1']))
  })

  it('an extrude off a body face relates no sketch', () => {
    const facePick = makeAncestryQuery(['@ex1', '@body_ex1'], 'flatface')
    const features: PartFeature[] = [extrude('ex1', '@sk1'), extrude('ex2', facePick), { id: 'sk1', kind: 'sketch' }]
    expect(partHints(['@ex2'], features).tree.size).toBe(0)
  })

  it('a rolled-back consumer hints nothing', () => {
    const features: PartFeature[] = [extrude('ex1', '@sk1'), { id: 'sk1', kind: 'sketch' }]
    expect(partHints(['@ex1'], features, {}, new Set(['sk1'])).tree.size).toBe(0)
  })
})

describe('sketch->consumers', () => {
  it('a selected sketch marks both features that consume it', () => {
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      extrude('ex1', '@sk1'),
      extrude('ex2', '@sk1'),
    ]
    expect(partHints(['@sk1'], features).tree).toEqual(new Set(['@ex1', '@ex2']))
    expect(partHints(['@sk1'], features).viewport.size).toBe(0)
  })

  it('a rolled-back consumer is not marked', () => {
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      extrude('ex1', '@sk1'),
      extrude('ex2', '@sk1'),
    ]
    expect(partHints(['@sk1'], features, {}, new Set(['sk1', 'ex1'])).tree).toEqual(new Set(['@ex1']))
  })
})

describe('builtins relate nothing', () => {
  it('a builtin selection produces no hint', () => {
    const features: PartFeature[] = [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      extrude('ex1', '@sk1'),
      { id: 'sk1', kind: 'sketch' },
    ]
    expect(partHints(['@builtin_origin', '@builtin_plane_top'], features).tree.size).toBe(0)
  })
})

// ─── assembly rules ───

function mate(id: string, partA: string, partB: string): MateFeature {
  return {
    id,
    mate: {
      kind: 'fixed',
      ref_a: { part: partA, anchor: 'a1' },
      ref_b: { part: partB, anchor: 'b1' },
    },
  }
}

const mates: MateFeature[] = [
  mate('m1', 'p1', 'p2'),
  mate('m2', 'p2', 'p3'),
  mate('m3', 'p1', 'p1'),  // self-mate
]

function assemblyHints(selection: string[]) {
  return relatedHints(hintDrivers(selection), ASSEMBLY_RULES, buildAssemblyRelationCtx(mates))
}

describe('part->mates', () => {
  it('collects every mate whose ref_a or ref_b names the part', () => {
    expect(assemblyHints(['p1']).tree).toEqual(new Set(['m1', 'm3']))
  })

  it('a part shared by two mates yields both ids', () => {
    expect(assemblyHints(['p2']).tree).toEqual(new Set(['m1', 'm2']))
  })

  it('returns nothing for a part with no mates', () => {
    expect(assemblyHints(['p9']).tree.size).toBe(0)
  })

  it('two selected parts relate the union of their mates', () => {
    expect(assemblyHints(['p1', 'p3']).tree).toEqual(new Set(['m1', 'm2', 'm3']))
  })

  it('nothing is related when nothing is selected', () => {
    expect(assemblyHints([]).tree).toBe(EMPTY_RELATION_SET)
  })
})

describe('mate->parts', () => {
  it('collects both part handles the mate references', () => {
    expect(assemblyHints(['m1']).tree).toEqual(new Set(['p1', 'p2']))
  })

  it('a self-mate yields a single part row', () => {
    expect(assemblyHints(['m3']).tree).toEqual(new Set(['p1']))
  })

  it('returns nothing for a mate id that does not exist', () => {
    expect(assemblyHints(['does-not-exist']).tree.size).toBe(0)
  })

  it('still returns a handle that no longer resolves to an instance', () => {
    const withGhostRef = [mate('m4', 'p1', 'ghost')]
    const hints = relatedHints(hintDrivers(['m4']), ASSEMBLY_RULES, buildAssemblyRelationCtx(withGhostRef))
    expect(hints.tree).toEqual(new Set(['p1', 'ghost']))
  })
})
