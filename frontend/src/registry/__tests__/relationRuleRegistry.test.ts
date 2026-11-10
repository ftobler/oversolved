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

function body(id: string, createdBy: string, overrides: Partial<BodyResult> = {}): BodyResult {
  return { id, created_by: createdBy, modified_by: [], ...overrides }
}

function partHints(
  selection: string[],
  features: PartFeature[],
  bodies: Record<string, BodyResult> = {},
  activeFeatureIds?: ReadonlySet<string>,
) {
  return relatedHints(
    hintDrivers(selection),
    PART_RULES,
    buildPartRelationCtx(features, bodies, activeFeatureIds),
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
