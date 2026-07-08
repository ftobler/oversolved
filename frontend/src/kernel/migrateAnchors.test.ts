import { describe, it, expect } from 'vitest'
import { migrateAnchors } from './partBundle'
import type { Anchor, AnchorKind } from './partBundle'

// ── Helpers ─────────────────────────────────────────────────────────────────

function mA(kind: AnchorKind, point: [number, number, number],
  axis: [number, number, number], geom_hash: string, created_by: string,
): Anchor {
  return { kind, point, axis, geom_hash, created_by }
}

function bundle(anchors: Record<string, Anchor>) {
  return { anchors }
}

function ids(result: Record<string, Anchor>): string[] {
  return Object.keys(result).sort()
}

/** Make a fresh bundle with predictable ids (pseudo-unique per test). */
function makeAnchors(
  specs: { label: string; kind: AnchorKind; point: [number, number, number];
    axis: [number, number, number]; geom_hash: string; created_by: string }[],
): Record<string, Anchor> {
  const out: Record<string, Anchor> = {}
  for (const s of specs) {
    out[s.label] = mA(s.kind, s.point, s.axis, s.geom_hash, s.created_by)
  }
  return out
}

const FEATURE_A = 'feat_a'
const FEATURE_B = 'feat_b'
const FEATURE_C = 'feat_c'

describe('migrateAnchors', () => {
  // ── Tier 1: same-rev rebuild (exact geom_hash) ─────────────────────────

  it('migrates every id via tier 1 when geom_hashes are unchanged', () => {
    const old = makeAnchors([
      { label: 'old_1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'old_2', kind: 'cylinder', point: [10,0,0], axis: [1,0,0], geom_hash: '@gdf|10,0,0|1,0,0', created_by: FEATURE_A },
      { label: 'old_3', kind: 'line', point: [5,0,0], axis: [1,0,0], geom_hash: '@gde|line|5,0,0|1,0,0|10', created_by: FEATURE_A },
    ])
    // New bundle: same anchors with fresh ids.
    const news = makeAnchors([
      { label: 'n1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n2', kind: 'cylinder', point: [10,0,0], axis: [1,0,0], geom_hash: '@gdf|10,0,0|1,0,0', created_by: FEATURE_A },
      { label: 'n3', kind: 'line', point: [5,0,0], axis: [1,0,0], geom_hash: '@gde|line|5,0,0|1,0,0|10', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect(ids(result)).toEqual(['old_1', 'old_2', 'old_3'])
    // Points are preserved from the new bundle geometry.
    expect(result['old_1'].point).toEqual([0, 0, 0])
    expect(result['old_2'].point).toEqual([10, 0, 0])
    expect(result['old_3'].point).toEqual([5, 0, 0])
  })

  // ── Tier 2: dimension edit moves a face (centroid changes) ──────────────

  it('migrates a moved face via tier 2 when geom_hash misses but created_by+kind is unique', () => {
    // Before edit: face at [0,0,0].
    const old = makeAnchors([
      { label: 'old_face1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
    ])
    // After edit: face moved to [5,0,0]; geom_hash changed.
    // Only one face from FEATURE_A in the new bundle → unique candidate.
    const news = makeAnchors([
      { label: 'n1', kind: 'plane', point: [5,0,0], axis: [0,0,1], geom_hash: '@gdf|5,0,0|0,0,1', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect(ids(result)).toEqual(['old_face1'])
    expect(result['old_face1'].point).toEqual([5, 0, 0]) // new geometry
    expect(result['old_face1'].geom_hash).toBe('@gdf|5,0,0|0,0,1')
  })

  it('migrates via tier 2 when created_by+kind matches exactly one new anchor', () => {
    const old = makeAnchors([
      { label: 'old_face', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'old_edge', kind: 'line', point: [5,0,0], axis: [1,0,0], geom_hash: '@gde|line|5,0,0|1,0,0|10', created_by: FEATURE_A },
    ])
    const news = makeAnchors([
      // face moved
      { label: 'n1', kind: 'plane', point: [3,0,0], axis: [0,0,1], geom_hash: '@gdf|3,0,0|0,0,1', created_by: FEATURE_A },
      // edge unchanged — tier 1 match
      { label: 'n2', kind: 'line', point: [5,0,0], axis: [1,0,0], geom_hash: '@gde|line|5,0,0|1,0,0|10', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect(ids(result).sort()).toEqual(['old_edge', 'old_face'].sort())
    expect(result['old_face'].point).toEqual([3, 0, 0]) // migrated via tier 2
    expect(result['old_edge'].point).toEqual([5, 0, 0]) // via tier 1
  })

  // ── Deleted feature ─────────────────────────────────────────────────────

  it('drops anchor ids from a deleted feature, keeps ids from other features', () => {
    const old = makeAnchors([
      { label: 'old_a1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'old_b1', kind: 'plane', point: [10,0,0], axis: [0,0,1], geom_hash: '@gdf|10,0,0|0,0,1', created_by: FEATURE_B },
    ])
    // Feature A deleted: only FEATURE_B anchors remain.
    const news = makeAnchors([
      { label: 'n_b1', kind: 'plane', point: [10,0,0], axis: [0,0,1], geom_hash: '@gdf|10,0,0|0,0,1', created_by: FEATURE_B },
      { label: 'n_b2', kind: 'line', point: [10,5,0], axis: [0,1,0], geom_hash: '@gde|line|10,5,0|0,1,0|10', created_by: FEATURE_B },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    // old_a1 dies (feature gone). old_b1 migrates via tier 1. n_b2 keeps fresh id.
    expect('old_a1' in result).toBe(false)
    expect('old_b1' in result).toBe(true)
    expect(result['old_b1'].point).toEqual([10, 0, 0])
    // n_b2 is a new anchor, keeps its fresh id.
    expect('n_b2' in result).toBe(true)
    expect(result['n_b2'].geom_hash).toBe('@gde|line|10,5,0|0,1,0|10')
    expect(Object.keys(result).length).toBe(2)
  })

  // ── Ambiguous tier-2 tie ─────────────────────────────────────────────────

  it('lets the id die when two candidates are equidistant (tie)', () => {
    // A feature creates two symmetric faces at equal distance from the
    // old face position. Neither is unambiguously nearest.
    const old = makeAnchors([
      { label: 'old_sym', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
    ])
    // Both new faces are at distance 10 from old face [0,0,0].
    const news = makeAnchors([
      { label: 'n_sym1', kind: 'plane', point: [10,0,0], axis: [0,0,1], geom_hash: '@gdf|10,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n_sym2', kind: 'plane', point: [-10,0,0], axis: [0,0,1], geom_hash: '@gdf|-10,0,0|0,0,1', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    // old_sym dies — fail-safe over fail-wrong.
    expect('old_sym' in result).toBe(false)
    // Both new anchors keep their fresh ids.
    expect('n_sym1' in result).toBe(true)
    expect('n_sym2' in result).toBe(true)
    expect(Object.keys(result).length).toBe(2)
  })

  it('matches via nearest when candidates are at different distances', () => {
    const old = makeAnchors([
      { label: 'old_a', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
    ])
    const news = makeAnchors([
      { label: 'n_far', kind: 'plane', point: [100,0,0], axis: [0,0,1], geom_hash: '@gdf|100,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n_near', kind: 'plane', point: [2,0,0], axis: [0,0,1], geom_hash: '@gdf|2,0,0|0,0,1', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    // Nearest candidate [2,0,0] wins.
    expect('old_a' in result).toBe(true)
    expect(result['old_a'].point).toEqual([2, 0, 0])
    // The far one keeps its fresh id.
    expect('n_far' in result).toBe(true)
  })

  // ── New geometry ─────────────────────────────────────────────────────────

  it('keeps fresh ids for new anchors that have no old counterpart', () => {
    const old = makeAnchors([
      { label: 'old_a1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
    ])
    // New bundle adds a new face (from a new feature or new geometry).
    const news = makeAnchors([
      { label: 'n_a1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n_new', kind: 'cylinder', point: [20,0,0], axis: [1,0,0], geom_hash: '@gdf|20,0,0|1,0,0', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect('old_a1' in result).toBe(true) // migrated via tier 1
    expect('n_new' in result).toBe(true)  // kept fresh id
    expect(result['n_new'].kind).toBe('cylinder')
    expect(result['n_new'].point).toEqual([20, 0, 0])
    expect(Object.keys(result).length).toBe(2)
  })

  // ── No old bundle (first ever build) ─────────────────────────────────────

  it('returns all new anchors unchanged when old bundle is empty', () => {
    const news = makeAnchors([
      { label: 'n1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n2', kind: 'line', point: [5,0,0], axis: [1,0,0], geom_hash: '@gde|5,0,0|1,0,0|10', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle({}), bundle(news))
    expect(ids(result)).toEqual(['n1', 'n2'])
  })

  // ── Mixed: some tier 1, some tier 2, some die ───────────────────────────

  it('handles mixed migration: some survive, some die', () => {
    const old = makeAnchors([
      { label: 'old_t1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'old_t2', kind: 'plane', point: [5,0,0], axis: [0,0,1], geom_hash: '@gdf|5,0,0|0,0,1', created_by: FEATURE_A }, // moves
      { label: 'old_die', kind: 'cylinder', point: [10,0,0], axis: [1,0,0], geom_hash: '@gdf|10,0,0|1,0,0', created_by: FEATURE_B }, // feature B gone
    ])
    const news = makeAnchors([
      { label: 'n1', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A }, // tier 1
      { label: 'n2', kind: 'plane', point: [5.1,0,0], axis: [0,0,1], geom_hash: '@gdf|5.1,0,0|0,0,1', created_by: FEATURE_A }, // moved face
      { label: 'n3', kind: 'plane', point: [50,0,0], axis: [0,0,1], geom_hash: '@gdf|50,0,0|0,0,1', created_by: FEATURE_C }, // new feature
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect('old_t1' in result).toBe(true)  // tier 1 survive
    expect('old_t2' in result).toBe(true)  // tier 2 survive (unique FEATURE_A + plane)
    expect('old_die' in result).toBe(false) // dies (FEATURE_B gone)
    expect('n3' in result).toBe(true)       // fresh id kept

    expect(result['old_t1'].point).toEqual([0, 0, 0])
    expect(result['old_t2'].point).toEqual([5.1, 0, 0])
    expect(result['n3'].point).toEqual([50, 0, 0])
    expect(Object.keys(result).length).toBe(3)
  })

  // ── Edge anchors ────────────────────────────────────────────────────────

  it('migrates edge anchors correctly across tiers', () => {
    const old = makeAnchors([
      { label: 'old_edge_t1', kind: 'line', point: [0,0,0], axis: [1,0,0], geom_hash: '@gde|line|0,0,0|1,0,0|10', created_by: FEATURE_A },
      { label: 'old_edge_t2', kind: 'circle', point: [5,0,0], axis: [0,0,1], geom_hash: '@gde|circle|5,0,0|0,0,1|2', created_by: FEATURE_A },
    ])
    const news = makeAnchors([
      { label: 'n_edge1', kind: 'line', point: [0,0,0], axis: [1,0,0], geom_hash: '@gde|line|0,0,0|1,0,0|10', created_by: FEATURE_A },
      { label: 'n_edge2', kind: 'circle', point: [5.2,0,0], axis: [0,0,1], geom_hash: '@gde|circle|5.2,0,0|0,0,1|2', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect('old_edge_t1' in result).toBe(true) // tier 1
    expect('old_edge_t2' in result).toBe(true) // tier 2 (unique FEATURE_A + circle)
  })

  // ── Vertex anchors ──────────────────────────────────────────────────────

  it('migrates vertex anchors via tier 1 and tier 2', () => {
    const old = makeAnchors([
      { label: 'old_v1', kind: 'point', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdv|0,0,0', created_by: FEATURE_A },
      { label: 'old_v2', kind: 'point', point: [10,0,0], axis: [0,0,1], geom_hash: '@gdv|10,0,0', created_by: FEATURE_A },
    ])
    const news = makeAnchors([
      { label: 'n_v1', kind: 'point', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdv|0,0,0', created_by: FEATURE_A },
      { label: 'n_v2', kind: 'point', point: [10.2,0,0], axis: [0,0,1], geom_hash: '@gdv|10.2,0,0', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    expect('old_v1' in result).toBe(true) // tier 1
    expect('old_v2' in result).toBe(true) // tier 2
  })

  // ── Collision safety ────────────────────────────────────────────────────

  it('does not confuse anchors across different kinds', () => {
    const old = makeAnchors([
      { label: 'old_line', kind: 'line', point: [0,0,0], axis: [1,0,0], geom_hash: '@gde|line|0,0,0|1,0,0|10', created_by: FEATURE_A },
    ])
    // Both have FEATURE_A but different kinds → only the line is a tier-2 candidate.
    const news = makeAnchors([
      { label: 'n_plane', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'n_line', kind: 'line', point: [0.1,0,0], axis: [1,0,0], geom_hash: '@gde|line|0.1,0,0|1,0,0|10', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    // Tier 1 fails (geom_hash changed). Tier 2: only n_line matches kind='line'.
    expect('old_line' in result).toBe(true)
    expect(result['old_line'].point).toEqual([0.1, 0, 0])
    expect('n_plane' in result).toBe(true) // keeps fresh id
  })

  // ── Same created_by, different feature kinds ────────────────────────────

  it('isolates by created_by — anchors from different features do not cross-match', () => {
    const old = makeAnchors([
      { label: 'old_a', kind: 'plane', point: [0,0,0], axis: [0,0,1], geom_hash: '@gdf|0,0,0|0,0,1', created_by: FEATURE_A },
      { label: 'old_b', kind: 'plane', point: [50,0,0], axis: [0,0,1], geom_hash: '@gdf|50,0,0|0,0,1', created_by: FEATURE_B },
    ])
    // Feature B anchors gone; only FEATURE_A remains.
    const news = makeAnchors([
      { label: 'n_a1', kind: 'plane', point: [0.1,0,0], axis: [0,0,1], geom_hash: '@gdf|0.1,0,0|0,0,1', created_by: FEATURE_A },
    ])

    const result = migrateAnchors(bundle(old), bundle(news))
    // old_a migrates via tier 2 (unique FEATURE_A + plane).
    expect('old_a' in result).toBe(true)
    // old_b dies — no FEATURE_B anchors in the new bundle.
    expect('old_b' in result).toBe(false)
    expect(Object.keys(result).length).toBe(1)
  })
})
