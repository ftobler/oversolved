import { describe, it, expect } from 'vitest'
import {
  build,
  edgeAncestryPayload,
  RESTORE_OWNER,
  type BuildDeps,
} from './builder'
import { resolve3dGeometry, projectTo2d } from './features/projectionLowering'
import type { BuildState, FeatureCheckpoint, Body } from './types3d'
import { makeDeps } from './builderTestUtils'

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
