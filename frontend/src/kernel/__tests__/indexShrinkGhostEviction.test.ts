// Guards for index-shrink-ghost-eviction: a body whose index range is
// re-registered with fewer faces/edges/vertices (or is deleted outright) must
// not leave the old tail indices resolvable forever. The registrars only evict
// the index tags they are about to re-register, so `registerBodyBrepFromMeta`
// clears the whole body first and `delete_body` routes through the same helper.

import { describe, it, expect } from 'vitest'
import {
  Repository,
  canonical,
  makeAncestryQuery,
  constructionUuidToken,
  clearBodyAncestry,
  evictAncestryAndRegister,
  ref,
} from '../query'
import { registerBodyBrepFromMeta, build, type BuildDeps } from '../builder'
import { faceGeometryHash, edgeGeometryHash } from '../geomHash'
import { solveDeleteBody } from '../features/deleteBody'
import { assertRepoIndicesConsistent, assertNoDeadUuidBuckets } from '../repoIndexTestUtil'
import { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'
import type { OccHandle } from '../occ/handleTable'

const oc = null as unknown as OccModule
const scope = null as never

function faceData(shape: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    centroid: [shape, i, 0],
    normal: [0, 0, 1],
    surface_type: 'flatface',
    classifiers: [],
  }))
}

function metaOf(shape: number, count: number): Record<string, unknown> {
  const edges = Array.from({ length: count }, (_, i) => ({
    kind: 'line', start: [i, 0, 0], end: [i + 1, 0, 0],
  }))
  const vertices = Array.from({ length: count }, (_, i) => [i, 0, 0])
  return {
    mesh: {
      vertices: [], faces: [], triangle_to_face: [], face_queries: [],
      face_data: faceData(shape, count),
      is_fallback: false,
    },
    edges,
    edge_queries: edges.map(() => '@eq'),
    vertices,
    vertex_queries: vertices.map(() => '@vq'),
    vertex_uuids: vertices.map(() => null),
  }
}

function makeBody(id: string, shape: number, createdBy: string, faceCount: number): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: null,
    sketch_id: 'sk1',
    brep_diff: null,
    profile_queries: [],
    face_names: Object.fromEntries(
      Array.from({ length: faceCount }, (_, i) => [
        faceGeometryHash([shape, i, 0], [0, 0, 1]),
        `u_${id}_f${i}`,
      ]),
    ),
    edge_names: Object.fromEntries(
      Array.from({ length: faceCount }, (_, i) => [
        edgeGeometryHash({ kind: 'line', start: [i, 0, 0], end: [i + 1, 0, 0] }),
        `u_${id}_e${i}`,
      ]),
    ),
  }
}

function faceKey(bodyId: string, idx: number): string {
  return canonical([`@${bodyId}/face${idx}`, '@ex1', `@${bodyId}`])
}

function faceQuery(bodyId: string, featureId: string, idx: number): string {
  return makeAncestryQuery([`@${bodyId}/face${idx}`, `@${featureId}`, `@${bodyId}`], 'flatface')
}

describe('clearBodyAncestry', () => {
  it('evicts every index of a body and prunes its dead uuid buckets', () => {
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 3), metaOf(1, 3))
    expect(repo.ancestral.has(faceKey('body_a', 2))).toBe(true)
    expect(repo.byUuid.has('u_body_a_f2')).toBe(true)

    clearBodyAncestry(repo, 'body_a')

    expect(repo.ancestral.has(faceKey('body_a', 0))).toBe(false)
    expect(repo.ancestral.has(faceKey('body_a', 2))).toBe(false)
    expect(repo.byUuid.has('u_body_a_f2')).toBe(false)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })

  it('is a no-op for a body that owns no entries', () => {
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 2), metaOf(1, 2))

    clearBodyAncestry(repo, 'body_ghost')

    expect(repo.ancestral.has(faceKey('body_a', 0))).toBe(true)
    assertRepoIndicesConsistent(repo)
  })
})

describe('index range shrink across a re-registration', () => {
  it('drops the tail faces when a modified body comes back with one fewer face', () => {
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 3), metaOf(1, 3))
    expect(repo.query(faceQuery('body_a', 'ex1', 2))).not.toBeNull()

    // The same body re-registers with two faces: the old face2 entry must die.
    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 3), metaOf(1, 2))

    expect(repo.ancestral.has(faceKey('body_a', 2))).toBe(false)
    expect(repo.query(faceQuery('body_a', 'ex1', 2))).toBeNull()
    expect(repo.byUuid.has('u_body_a_f2')).toBe(false)
    expect(repo.byUuid.has('u_body_a_f0')).toBe(true)

    // The surviving range resolves, and the shrink is exact.
    expect((repo.query(faceQuery('body_a', 'ex1', 0)) as { face_index?: number }).face_index).toBe(0)
    expect((repo.query(faceQuery('body_a', 'ex1', 1)) as { face_index?: number }).face_index).toBe(1)
    expect(repo.ancestral.has(faceKey('body_a', 0))).toBe(true)
    expect(repo.ancestral.has(faceKey('body_a', 1))).toBe(true)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })

  it('leaves a body whose range did not change alone', () => {
    const repo = new Repository()
    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 2), metaOf(1, 2))
    const before = repo.ancestral.size

    registerBodyBrepFromMeta(repo, makeBody('body_a', 1, 'ex1', 2), metaOf(1, 2))

    expect(repo.ancestral.size).toBe(before)
    // The payload-equality dedup-skip is gone; idempotency now rests entirely on
    // clearBodyAncestry + evictAncestryAndRegister. Pin exactly one element per face
    // key so a reintroduced additive registration is caught here.
    expect(repo.ancestral.get(faceKey('body_a', 0))?.eids).toHaveLength(1)
    expect(repo.ancestral.get(faceKey('body_a', 1))?.eids).toHaveLength(1)
    expect(repo.ancestral.has(faceKey('body_a', 0))).toBe(true)
    expect(repo.ancestral.has(faceKey('body_a', 1))).toBe(true)
    expect(repo.query(faceQuery('body_a', 'ex1', 0))).not.toBeNull()
    expect(repo.byUuid.has('u_body_a_f0')).toBe(true)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })

  it('re-registering the same count still yields exactly one entry per index', () => {
    const repo = new Repository()
    const tag = '@body_a/face0'
    const ids = [tag, '@ex1', '@body_a']
    evictAncestryAndRegister(repo, ids, { type: 'flatface', body_id: 'body_a' }, tag, 'u_f0')

    clearBodyAncestry(repo, 'body_a')
    const fresh = evictAncestryAndRegister(repo, ids, { type: 'flatface', body_id: 'body_a' }, tag, 'u_f0')

    // The exact-key branch runs against an already-cleared key, so exactly one
    // element survives (the clear is idempotent with it, not additive).
    expect(repo.ancestral.get(canonical(ids))?.eids).toEqual([fresh])
    expect(repo.byUuid.get('u_f0')).toEqual([fresh])
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })
})

describe('delete_body repo cleanup', () => {
  it("drops the deleted body's entries, uuids and solid; other bodies untouched", () => {
    const repo = new Repository()
    const bodyStore: Record<string, Body> = {
      body_a: makeBody('body_a', 1, 'ex1', 2),
      body_b: makeBody('body_b', 2, 'ex2', 2),
    }
    registerBodyBrepFromMeta(repo, bodyStore.body_a, metaOf(1, 2))
    registerBodyBrepFromMeta(repo, bodyStore.body_b, metaOf(2, 2))
    // Solids are registered under the creating feature's bare tag (builder.ts).
    repo.registerAncestor([ref('ex1')], { type: 'solid', body_id: 'body_a', created_by: 'ex1' })
    repo.registerAncestor([ref('ex2')], { type: 'solid', body_id: 'body_b', created_by: 'ex2' })

    const result = solveDeleteBody(
      oc, scope, new HandleTable(),
      { id: 'del', delete_body: { bodies: ['body_a'] } }, repo, bodyStore,
    )

    expect(result).toEqual({ status: 'ok', deleted_body_ids: ['body_a'] })
    expect(Object.keys(bodyStore)).toEqual(['body_b'])

    // Deleted body's face/edge/vertex/solid entries are unresolvable.
    expect(repo.query(faceQuery('body_a', 'ex1', 0))).toBeNull()
    expect(repo.query(makeAncestryQuery(['@body_a/edge0', '@ex1', '@body_a'], 'straightedge'))).toBeNull()
    expect(repo.query(makeAncestryQuery(['@body_a/vertex0', '@ex1', '@body_a'], 'vertex'))).toBeNull()
    expect(repo.query(makeAncestryQuery(['@ex1'], 'solid'))).toBeNull()
    expect(repo.byUuid.has('u_body_a_f0')).toBe(false)

    // The other body still resolves, solid included.
    expect(repo.query(faceQuery('body_b', 'ex2', 0))).not.toBeNull()
    expect(repo.query(makeAncestryQuery(['@ex2'], 'solid'))).not.toBeNull()
    expect(repo.byUuid.has('u_body_b_f0')).toBe(true)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })
})

describe('consumed body repo cleanup', () => {
  // A boolean tool (or a fused array source) leaves the body store mid-build
  // without any solver clearing the repo. Its faces used to stay live carrying
  // the very construction UUIDs the surviving body inherits from them, and the
  // resolver's UUID tier then refused every pick of such a face with
  // "collision by construction". The build loop evicts the vanished body.
  function consumingBuild(): { repo: Repository; features: Array<Record<string, unknown>> } {
    const repo = new Repository()
    const features = [
      { id: 'ex1', kind: 'extrude' },
      { id: 'ex2', kind: 'extrude' },
      { id: 'bool', kind: 'boolean' },
    ]
    return { repo, features }
  }

  function depsFor(repo: Repository): BuildDeps {
    return {
      // ex1 makes the target, ex2 the tool, bool consumes the tool and inherits
      // its face UUIDs onto the target (what `transferBooleanNames` does).
      trySolveFeature: (feature, _repo, bodyStore) => {
        const fid = String(feature.id)
        if (fid === 'ex1') bodyStore.body_a = { ...makeBody('body_a', 1, 'ex1', 2), shape: 1 as OccHandle }
        if (fid === 'ex2') bodyStore.body_b = { ...makeBody('body_b', 2, 'ex2', 2), shape: 2 as OccHandle }
        if (fid === 'bool') {
          const target = bodyStore.body_a
          target.modified_by.push('bool')
          target.face_names = {
            ...target.face_names,
            [faceGeometryHash([1, 0, 0], [0, 0, 1])]: 'u_body_b_f0',
          }
          delete bodyStore.body_b
        }
        return { status: 'ok' }
      },
      postRegister: () => {},
      initGlobalRepo: () => repo,
      tessellateBodies: (bodyStore) =>
        Object.fromEntries(
          Object.keys(bodyStore).map((bid) => [bid, metaOf(bid === 'body_a' ? 1 : 2, 2)]),
        ),
    }
  }

  it('evicts the consumed body so its inherited uuid resolves the survivor', () => {
    const { repo, features } = consumingBuild()
    build({ features }, { prevState: null }, depsFor(repo))

    // The tool's own face entries are gone, and the uuid it handed to the
    // target resolves to exactly one live element: the target's face.
    expect(repo.query(faceQuery('body_b', 'ex2', 0))).toBeNull()
    expect(repo.byUuid.get('u_body_b_f0')?.filter((e) => repo.elements.has(e))).toHaveLength(1)
    const hit = repo.query(makeAncestryQuery([constructionUuidToken('u_body_b_f0')], 'flatface'))
    expect((hit as { body_id?: string }).body_id).toBe('body_a')

    // The consumed body's solid entry dies with it; the survivor keeps its own.
    expect(repo.query(makeAncestryQuery(['@ex2'], 'solid'))).toBeNull()
    expect(repo.query(makeAncestryQuery(['@ex1'], 'solid'))).not.toBeNull()
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })
})
