import { describe, it, expect } from 'vitest'
import {
  build,
  edgeAncestryPayload,
  RESTORE_OWNER,
  type BuildDeps,
} from '../builder'
import { resolve3dGeometry, projectTo2d } from '../features/projectionLowering'
import type { BuildState, FeatureCheckpoint, Body } from '../types3d'
import { makeDeps } from '../builderTestUtils'
import { registerBodyBrepFromMeta } from '../builderAncestry'
import { Repository, makeAncestryQuery, constructionUuidToken, classifiersOfQuery } from '../query'

describe('edgeAncestryPayload (projection round-trip)', () => {
  const XY = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }

  it('carries ellipse semi-axes so a resolved elliptical edge can be projected', () => {
    // Regression: the payload used to omit a/b, so resolve3dGeometry returned
    // null for a registered elliptical edge and the projection silently failed.
    const edge = {
      kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI,
    }
    const payload = edgeAncestryPayload(edge, '@body_1', '@cut1', 3)
    expect(payload.a).toBe(4)
    expect(payload.b).toBe(2)

    // The payload (as globalRepo would hand it back) must resolve to 3D ellipse
    // geometry and project to a 5-param ellipse on a coplanar sketch plane.
    const g = resolve3dGeometry({ type: 'edge', ...payload })
    expect(g?.kindH).toBe('ellipse')
    const out = projectTo2d(g!, XY)
    expect(out?.kind).toBe('ellipse')
    expect(out?.params).toHaveLength(5)
  })

  it('still carries radius for circle/arc edges', () => {
    const payload = edgeAncestryPayload(
      { kind: 'circle', center: [1, 2, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '@body_1', '@ex1', 0,
    )
    expect(payload.radius).toBe(5)
    expect(payload.type).toBe('edge')
  })
})

describe('B-rep edge registration carries the classifiers of its own query', () => {
  const body = {
    id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: null, sketch_id: '',
    brep_diff: null, profile_queries: [],
  } as unknown as Body
  const edges = [
    { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
    { kind: 'line', start: [0, 0, 5], end: [10, 0, 5] },
  ]

  it('registers the cls_* set minted into the edge query, not []', () => {
    // The registered payload used to be [] for every OCC edge while the query
    // carried @cls_* tokens, so the classifier tier had no evidence on edges.
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, body, {
      edges,
      edge_queries: [
        makeAncestryQuery(['@ex1', '@body_ex1', '@cls_zn'], 'straightedge'),
        makeAncestryQuery(['@ex1', '@body_ex1', '@cls_zp'], 'straightedge'),
      ],
    })
    const byIndex = (i: number) => [...repo.elements.values()].find(
      (e) => (e as { edge_index?: number }).edge_index === i,
    ) as { classifiers: string[] }
    expect(byIndex(0).classifiers).toEqual(['cls_zn'])
    expect(byIndex(1).classifiers).toEqual(['cls_zp'])

    // ... so the two lineage-sharing edges are told apart by their classifier.
    const q = makeAncestryQuery(['@ex1', '@body_ex1', '@cls_zp'], 'straightedge')
    expect((repo.query(q) as { edge_index: number }).edge_index).toBe(1)
  })

  it('a dead-uuid edge query whose classifiers contradict every sibling misses', () => {
    // With real evidence on edges, a stale pick no longer resolves a sibling as
    // "no evidence": it goes red instead of actuating a different edge.
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, body, {
      edges,
      edge_queries: [
        makeAncestryQuery(['@ex1', '@body_ex1', '@cls_zn'], 'straightedge'),
        makeAncestryQuery(['@ex1', '@body_ex1', '@cls_zp'], 'straightedge'),
      ],
    })
    const stale = makeAncestryQuery([constructionUuidToken('e_dead'), '@ex1', '@body_ex1', '@cls_xp'], 'straightedge')
    expect(repo.query(stale)).toBeNull()
    expect(repo._lastTier).toBe('miss')
  })
})

describe('classifiersOfQuery', () => {
  it('reads the bare classifier names of an ancestry query', () => {
    expect(classifiersOfQuery(makeAncestryQuery(['@u|e_1', '@ex1', '@cls_xp', '@cls_yn'], 'edge'))).toEqual(['cls_xp', 'cls_yn'])
  })

  it('is [] for an empty, non-ancestry or malformed string, never a throw', () => {
    expect(classifiersOfQuery('')).toEqual([])
    expect(classifiersOfQuery('@ex1/face0')).toEqual([])
    expect(classifiersOfQuery('?zz;@ex1')).toEqual([])
    expect(classifiersOfQuery('?9;@ex1')).toEqual([])
  })
})

describe('clean-prefix restore copies are owned per build', () => {
  // Body shapes are opaque handles to the deps; plain numbers suffice here.
  const shapeOf = (n: number): NonNullable<Body['shape']> => n as unknown as NonNullable<Body['shape']>

  function bodySnapshot(fid: string, shapes: number[]): Record<string, Body> {
    const out: Record<string, Body> = {}
    shapes.forEach((s, i) => {
      out[`body_${fid}_${i}`] = {
        id: `body_${fid}_${i}`,
        created_by: fid,
        modified_by: [],
        shape: shapeOf(s),
        sketch_id: '',
        brep_diff: null,
        profile_queries: [],
      }
    })
    return out
  }

  function cpWithBodies(fid: string, spec: Record<string, unknown>, shapes: number[]): FeatureCheckpoint {
    return {
      spec,
      result: {},
      repo_snapshot: { elements: {}, ancestral: {}, byUuid: {} },
      body_store_snapshot: bodySnapshot(fid, shapes),
      bodies_snapshot: {},
    }
  }

  function makeRestoreTrackingDeps(events: string[]): BuildDeps {
    return makeDeps({
      copyBodyShape: (_shape, owner) => {
        events.push(`copy:${owner}`)
        return shapeOf(1000 + events.length)
      },
      retainCheckpointShape: (_h, owner) => {
        events.push(`retain:${owner}`)
        return shapeOf(0)
      },
      releaseCheckpoint: (fid) => events.push(`evict:${fid}`),
      releaseRestoreCopies: () => events.push('releaseRestore'),
    })
  }

  it('tags every copy with RESTORE_OWNER and releases the previous batch before minting new ones', () => {
    const specA = { id: 'a', kind: 'sketch' }
    const specB = { id: 'b', kind: 'extrude', distance: 5 }
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: { a: cpWithBodies('a', specA, [1]), b: cpWithBodies('b', specB, []) },
    }

    // First incremental build: evict the discarded checkpoint, release the
    // (nonexistent) prior batch, then mint exactly one copy per clean body.
    const events1: string[] = []
    const r2 = build(
      { features: [specA, { ...specB, distance: 7 }] },
      { prevState: prev },
      makeRestoreTrackingDeps(events1),
    )
    expect((r2.result as Record<string, { status?: string }>).b.status).toBe('ok')
    expect(events1.filter((e) => e.startsWith('copy:'))).toEqual([`copy:${RESTORE_OWNER}`])
    expect(events1.indexOf('releaseRestore')).toBeGreaterThanOrEqual(0)
    expect(events1.indexOf('releaseRestore')).toBeLessThan(events1.indexOf(`copy:${RESTORE_OWNER}`))

    // Second incremental build over the new state: the first build's batch is
    // released before the next one is minted. This ordering is the whole leak
    // fix -- an untagged or never-released batch would strand one deep copy
    // per body per edit in the real OCC table.
    const events2: string[] = []
    const r3 = build(
      { features: [specA, { ...specB, distance: 9 }] },
      { prevState: r2._build_state as BuildState },
      makeRestoreTrackingDeps(events2),
    )
    expect((r3.result as Record<string, { status?: string }>).b.status).toBe('ok')
    expect(events2.indexOf('releaseRestore')).toBeLessThan(events2.indexOf(`copy:${RESTORE_OWNER}`))
    expect(events2.filter((e) => e === `copy:${RESTORE_OWNER}`)).toHaveLength(1)
  })

  it('evicts discarded checkpoints and their feature ids before restoring', () => {
    // The eviction loop must free BOTH owner tags of the outgoing generation:
    // the checkpoint retain ('cp:<fid>') and the base body registration
    // (<fid>). The wiring contract is pinned here at the call level.
    const specA = { id: 'a', kind: 'sketch' }
    const specB = { id: 'b', kind: 'extrude' }
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: { a: cpWithBodies('a', specA, [1]), b: cpWithBodies('b', specB, [2]) },
    }
    const events: string[] = []
    build({ features: [specA, { ...specB, distance: 3 }] }, { prevState: prev }, makeRestoreTrackingDeps(events))
    expect(events).toContain('evict:b')
    expect(events).not.toContain('evict:a')  // clean prefix survives untouched
    expect(events.indexOf('evict:b')).toBeLessThan(events.indexOf(`copy:${RESTORE_OWNER}`))
  })
})
