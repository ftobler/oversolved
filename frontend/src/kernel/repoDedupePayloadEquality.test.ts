// feature-repo-dedupe-payload-equality: live and restored repos must agree on
// duplicates. `_registerExtrusionFeature` registers one byte-identical payload
// per body a feature owns, so a 2-body feature left TWO identical
// `extrusion-feature` elements under `[@fid]` live while `repoFromSnapshot`
// collapsed them to one - `?@fid:extrusion-feature` threw AmbiguousQueryError
// live and resolved after a round-trip. Decision (a): dedupe on insert, so
// live holds exactly one and the query behaves identically before and after
// a snapshot round-trip. Solids stay one per body (their payloads carry the
// body id) and must stay ambiguous for a multi-body feature in both worlds.
//
// The harness is OCC-free like the parity suite: `initGlobalRepo` hands out a
// captured Repository so the live build state can be queried directly, while
// `repoFromSnapshot` on its snapshot is the restored world.

import { describe, it, expect } from 'vitest'
import {
  build,
  repoFromSnapshot,
  snapshotRepo,
  stableJson,
  type BuildDeps,
  type FeatureResult,
} from './builder'
import { Repository, makeAncestryQuery, AmbiguousQueryError, canonical } from './query'
import { repoSemanticFingerprint } from './repoFingerprintTestUtil'
import type { Body } from './types3d'

function makeBody(fid: string, id: string): Body {
  return {
    id,
    created_by: fid,
    modified_by: [],
    shape: 100 as unknown as Body['shape'],
    sketch_id: 'sk_' + fid,
    brep_diff: null,
    profile_queries: ['@profile_' + fid],
  }
}

/** A `trySolveFeature` that creates TWO bodies for one feature, so `[@fid]`
 *  would receive one solid + one extrusion-feature per body. */
function solveTwoBodies(
  feature: Record<string, unknown>,
  _repo: Repository,
  bodyStore: Record<string, Body>,
): FeatureResult {
  const fid = String(feature.id ?? '')
  bodyStore['body_' + fid] = makeBody(fid, 'body_' + fid)
  bodyStore['body_' + fid + '_1'] = makeBody(fid, 'body_' + fid + '_1')
  return { status: 'ok' }
}

function twoBodyDeps(liveRepo: Repository): BuildDeps {
  return {
    trySolveFeature: solveTwoBodies,
    postRegister: () => {},
    initGlobalRepo: () => liveRepo,
    tessellateBodies: () => ({}),
    extractBrepMetadata: () => ({}),
    brepDiffNewFaceHashes: () => new Set<string>(),
    brepDiffNewEdgeHashes: () => new Set<string>(),
    brepDiffNewVertexHashes: () => new Set<string>(),
  }
}

describe('live == restored duplicate semantics', () => {
  it('a two-body feature leaves exactly one extrusion-feature, live and restored', () => {
    const liveRepo = new Repository()
    build(
      { features: [{ id: 'f1', kind: 'make' }] },
      { prevState: null },
      twoBodyDeps(liveRepo),
    )

    const entry = [...liveRepo.ancestral.values()].find((e) => {
      const set = [...e.set]
      return set.length === 1 && set[0] === '@f1'
    })!
    const extrusionLive = entry.eids.filter((eid) => {
      const el = liveRepo.elements.get(eid) as Record<string, unknown> | undefined
      return el?.type === 'extrusion-feature'
    })
    // Dedupe-on-insert: one extrusion-feature element for the whole feature,
    // not one per body.
    expect(extrusionLive).toHaveLength(1)

    const q = makeAncestryQuery(['@f1'], 'extrusion-feature')
    const live = liveRepo.query(q)
    const restored = repoFromSnapshot(snapshotRepo(liveRepo))
    const after = restored.query(q)

    // Both resolve (no AmbiguousQueryError) and agree with each other.
    expect(live).not.toBeNull()
    expect(after).not.toBeNull()
    expect(live).toEqual(after)
    expect((live as Record<string, unknown>).type).toBe('extrusion-feature')
    expect((live as Record<string, unknown>).feature_id).toBe('f1')
  })

  it('solids stay one per body and remain ambiguous in both worlds', () => {
    // The counterweight to dedupe-on-insert: solid payloads carry `body_id`, so
    // a 2-body feature owns two DISTINCT solids under `[@f1]`. Those must not
    // be merged - `?@f1:solid` throws AmbiguousQueryError live and restored.
    const liveRepo = new Repository()
    build(
      { features: [{ id: 'f1', kind: 'make' }] },
      { prevState: null },
      twoBodyDeps(liveRepo),
    )
    const q = makeAncestryQuery(['@f1'], 'solid')

    expect(() => liveRepo.query(q)).toThrow(AmbiguousQueryError)

    const restored = repoFromSnapshot(snapshotRepo(liveRepo))
    expect(() => restored.query(q)).toThrow(AmbiguousQueryError)

    // Both solids survived the round-trip (no over-deduping).
    const entry = [...restored.ancestral.values()].find((e) => {
      const set = [...e.set]
      return set.length === 1 && set[0] === '@f1'
    })!
    const solidBodies = entry.eids
      .map((eid) => restored.elements.get(eid) as Record<string, unknown> | undefined)
      .filter((el) => el?.type === 'solid')
      .map((el) => el!.body_id)
      .sort()
    expect(solidBodies).toEqual(['body_f1', 'body_f1_1'])
  })
})

describe('one payload-equality predicate everywhere', () => {
  it('the fingerprint of a restored repo equals the fingerprint of its source', () => {
    // The parity fingerprint replays `_dedupeRepo` with its OWN hash. If that
    // hash disagreed with the dedupe's (the old allowlist collapsed nested
    // content), a restore would DELETE an element the fingerprint still counts,
    // so the fingerprint of the re-snapshot would differ from the source's -
    // the exact divergence the parity gate exists to catch. Equal fingerprints
    // pin that `repoFromSnapshot` and `repoSemanticFingerprint` share one
    // nested-aware predicate.
    const snap = {
      elements: {
        id1: { type: 'solid', body_id: 'b1', meta: { ref: 'a' } },
        id2: { type: 'solid', body_id: 'b1', meta: { ref: 'b' } },
      },
      ancestral: {
        [canonical(['@ex1'])]: { set: ['@ex1'], eids: ['id1', 'id2'] },
      },
      byUuid: {},
    }
    const normalized = snapshotRepo(repoFromSnapshot(snap))
    expect(repoSemanticFingerprint(normalized)).toEqual(repoSemanticFingerprint(snap))
  })

  it('hashes two payloads differing only in Map entries differently', () => {
    // The Map branch sorts entries before stringifying, so it is the one place
    // the predicate sees content the plain-object branch would hide under key
    // order. Two Maps that differ in a value must hash differently or a dedupe
    // could merge distinct payloads.
    const a = new Map<string, unknown>([
      ['k', { ref: 'a' }],
      ['j', 1],
    ])
    const b = new Map<string, unknown>([
      ['k', { ref: 'b' }],
      ['j', 1],
    ])
    expect(stableJson(a)).not.toBe(stableJson(b))
  })

  it('is insensitive to Map key insertion order', () => {
    // Sorted-entry semantics: the same entries in a different insertion order
    // hash equal, so a snapshot round-trip that rebuilds a Map in a different
    // order never trips the dedupe or the parity fingerprint.
    const a = new Map<string, number>([
      ['k', 1],
      ['j', 2],
    ])
    const b = new Map<string, number>([
      ['j', 2],
      ['k', 1],
    ])
    expect(stableJson(a)).toBe(stableJson(b))
  })

  it('the fingerprint reflects nested-content differences', () => {
    // A nested-only difference must move the fingerprint, or the parity gate
    // could never see a payload being merged or dropped by a dedupe regression.
    const base = {
      elements: { id1: { type: 'solid', body_id: 'b1', meta: { ref: 'a' } } },
      ancestral: { [canonical(['@ex1'])]: { set: ['@ex1'], eids: ['id1'] } },
      byUuid: {},
    }
    const changed = {
      ...base,
      elements: { id1: { ...base.elements.id1, meta: { ref: 'b' } } },
    }
    expect(repoSemanticFingerprint(changed)).not.toEqual(repoSemanticFingerprint(base))
  })
})

describe('stableJson collision classes the doc comment documents', () => {
  it('an undefined array element collides with null', () => {
    // JSON.stringify serializes an undefined array element as null, so the two
    // payloads hash equal even though their content differs. Pinning the
    // collision keeps the documented contract honest: a future payload that
    // accidentally carries an undefined array entry merges with its null twin.
    expect(stableJson([1, undefined])).toBe(stableJson([1, null]))
  })

  it('an undefined-valued object key is dropped', () => {
    // JSON.stringify omits keys whose value is undefined, so `{a: undefined}`
    // hashes like the empty object.
    expect(stableJson({ a: undefined })).toBe(stableJson({}))
  })

  it('NaN in an object value collides with null', () => {
    // JSON.stringify serializes NaN as null, so `{a: NaN}` hashes like
    // `{a: null}`.
    expect(stableJson({ a: NaN })).toBe(stableJson({ a: null }))
  })

  it('a Map collides with a plain object holding the same entries', () => {
    // The Map branch converts the map to a sorted-key object, so a Map and a
    // plain object with the same entries are indistinguishable.
    expect(stableJson(new Map([['a', 1]]))).toBe(stableJson({ a: 1 }))
  })

  it('is insensitive to object key order', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }))
  })

  it('normalizes -0 to 0', () => {
    expect(stableJson(-0)).toBe(stableJson(0))
  })

  it('still hashes genuinely different JSON-clean payloads differently', () => {
    // The collision classes are coarse, but a real content difference in
    // JSON-clean payloads must still move the hash, or the dedupe could merge
    // distinct elements.
    expect(stableJson({ a: 1, nested: { ref: 'x' } })).not.toBe(
      stableJson({ a: 1, nested: { ref: 'y' } }),
    )
  })
})
