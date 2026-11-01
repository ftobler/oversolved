// @vitest-environment node
//
// A persisted `@<body>/face/<N>` helix pick is remapped through the body's
// construction UUIDs, exactly like the extrude/revolve profile paths. When the
// upstream edit reorders faces and the stored index's face no longer carries a
// resolvable UUID, the helix must refuse by name instead of reading the raw
// index (which may hit a different cylinder). Skips when opencascade.js is
// absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { sortedFacesOf } from '../../occ/faceLoops'
import { canonicalFaces, canonicalIndex } from '../../occ/bodyNames'
import { makeCylinderWithFaces } from '../../occ/primitives'
import { solveHelix } from '../helix'
import type { Body } from '../../types3d'
import type { OccShape, OccSubShape } from '../../occ/occTypes'

const oc = await loadOcc()

interface FaceIf extends OccShape { IsSame(other: OccShape): boolean }

function indexOfFace(occ: NonNullable<typeof oc>, scope: DisposeScope, shape: OccShape, face: OccShape): number {
  const faces = sortedFacesOf(occ, scope, shape)
  const target = face as FaceIf
  return faces.findIndex((f) => target.IsSame(f))
}

describe.skipIf(!oc)('helix face remap (real OCC)', () => {
  it('refuses a slash face ref whose UUID no longer maps', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const { shape, faces } = makeCylinderWithFaces(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const body: Body = {
        id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: table.register(shape, 'ex1'),
        sketch_id: 'sk1', brep_diff: null, profile_queries: [],
      }
      const bodyStore: Record<string, Body> = { body_ex1: body }
      const lateral = indexOfFace(oc!, scope, shape, faces.lateral)

      // The repo entry a slash pick resolves through, as the builder registers a
      // cylinder face.
      repo.register(`body_ex1/face/${lateral}`, {
        type: 'cylinderface', body_id: 'body_ex1', face_index: lateral,
        axis: [0, 0, 1], centroid: [0, 0, 5], normal: [1, 0, 0],
      })

      // The body carries face identity, but the face at the stored index lost
      // the UUID it was picked with (the edit rebuilt the shape and reordered
      // its faces); another face still has one, so this is a genuine body with
      // identity rather than a plain unnamed extrude.
      const canon = canonicalFaces(oc!, scope, shape)
      const at = canonicalIndex(canon).get(faces.top as OccSubShape)
      const uuids: (string | null)[] = canon.map(() => null)
      if (at >= 0) uuids[at] = 'u_surviving_face'
      body.face_uuids = uuids

      expect(() => solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: {
          reference: `@body_ex1/face/${lateral}`, radius_mode: 'derived',
          mode: 'pitch_height', pitch: 2, height_from_reference: true,
          hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
        },
      }, repo, bodyStore)).toThrow(/Cannot remap persisted face ref/)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  // The geometry fuzz's seed 976 regression: the remap is for a persisted slash
  // index only. A repo query resolves to the current face index already, so a
  // UUID-less face on a partly named body is still a live pick, not a refusal.
  it('resolves a repo query to a face without a UUID on a partly named body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const { shape, faces } = makeCylinderWithFaces(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const body: Body = {
        id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: table.register(shape, 'ex1'),
        sketch_id: 'sk1', brep_diff: null, profile_queries: [],
      }
      const lateral = indexOfFace(oc!, scope, shape, faces.lateral)
      repo.register('pick/helix/s1', {
        type: 'cylinderface', body_id: 'body_ex1', face_index: lateral,
        axis: [0, 0, 1], centroid: [0, 0, 5], normal: [1, 0, 0],
      })
      const canon = canonicalFaces(oc!, scope, shape)
      const at = canonicalIndex(canon).get(faces.top as OccSubShape)
      const uuids: (string | null)[] = canon.map(() => null)
      if (at >= 0) uuids[at] = 'u_surviving_face'
      body.face_uuids = uuids

      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: {
          reference: '@pick/helix/s1', radius_mode: 'derived',
          mode: 'pitch_height', pitch: 2, height_from_reference: true,
          hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
        },
      }, repo, { body_ex1: body })
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(5)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('keeps the raw index for a body with no face identity', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const { shape, faces } = makeCylinderWithFaces(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const body: Body = {
        id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: table.register(shape, 'ex1'),
        sketch_id: 'sk1', brep_diff: null, profile_queries: [],
      }
      const lateral = indexOfFace(oc!, scope, shape, faces.lateral)
      repo.register(`body_ex1/face/${lateral}`, {
        type: 'cylinderface', body_id: 'body_ex1', face_index: lateral,
        axis: [0, 0, 1], centroid: [0, 0, 5], normal: [1, 0, 0],
      })
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: {
          reference: `@body_ex1/face/${lateral}`, radius_mode: 'derived',
          mode: 'pitch_height', pitch: 2, height_from_reference: true,
          hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
        },
      }, repo, { body_ex1: body })
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(5)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
