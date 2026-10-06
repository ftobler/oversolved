// Pure tests for up-to terminator resolution + distance (feature: extrude-up-to).
// The plane / point branches of resolveUpToPlane do not touch OCC, so oc/scope/
// table are unused here and passed as null. The body-face branch's two OCC reads
// (extractOccFace, computeFacePlane) are stood in so its success and non-planar
// outcomes are pinned without the opencascade.js artifact; trimAtPlane's cap-face
// guard is driven through a fake oc that reports a not-done builder.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveUpToPlane, upToDistance, orientToTarget, trimAtPlane, type CutPlane } from '../upTo'
import { AmbiguousQueryError } from '../../query'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { DisposeScope } from '../../occ/disposeScope'
import type { HandleTable } from '../../occ/handleTable'

// The body-face branch reads a real OCC face through these two functions; the
// OCC-free harness stands them in so the success and non-planar outcomes are
// pinned even when opencascade.js is absent (where upToReal.test.ts skips).
vi.mock('../../occ/faceLoops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/faceLoops')>()
  return { ...actual, extractOccFace: vi.fn(), computeFacePlane: vi.fn() }
})
import { extractOccFace, computeFacePlane } from '../../occ/faceLoops'

afterEach(() => {
  vi.mocked(extractOccFace).mockReset()
  vi.mocked(computeFacePlane).mockReset()
})

function repoReturning(entry: unknown): Repository {
  return { query: () => entry } as unknown as Repository
}

const noOcc = null as unknown as OccModule
const noScope = null as unknown as DisposeScope
const noTable = null as unknown as HandleTable

describe('resolveUpToPlane', () => {
  it('resolves a registered plane / flatface to origin + normal', () => {
    const repo = repoReturning({ type: 'flatface', origin: [0, 0, 7], normal: [0, 0, 1] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [0, 0, 7], normal: [0, 0, 1] })
  })

  it('resolves a datum plane registered under the `plane` tag', () => {
    // A datum plane registers as `type: 'plane'` (plane.ts), an extrude
    // top_face under `flatface`. Admitting only the latter made a datum-plane
    // up_to pick resolve to nothing and silently extrude the blind distance.
    const repo = repoReturning({ type: 'plane', origin: [0, 0, 4], normal: [0, 0, 1] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [0, 0, 4], normal: [0, 0, 1] })
  })

  it('resolves a point to a plane perpendicular to the extrude direction', () => {
    const repo = repoReturning({ point: [1, 2, 4] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [1, 2, 4], normal: [0, 0, 1] })
  })

  it('returns null for an unresolved ref', () => {
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repoReturning(null), {})).toBeNull()
    expect(resolveUpToPlane(noOcc, noScope, noTable, '', [0, 0, 1], repoReturning({ normal: [0, 0, 1], origin: [0, 0, 1] }), {})).toBeNull()
  })

  it('rethrows ambiguity instead of reporting the pick as dangling', () => {
    // An ambiguous ref matched SEVERAL elements; folding that into the null
    // fallback made the extrude report "did not resolve", which is false.
    const ambiguousRepo = {
      query: () => {
        throw new AmbiguousQueryError("query '?q' matched 3 elements")
      },
    } as unknown as Repository
    expect(() =>
      resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], ambiguousRepo, {}),
    ).toThrow(AmbiguousQueryError)
  })

  it('still folds non-ambiguity query failures into the null fallback', () => {
    const brokenRepo = {
      query: () => {
        throw new Error('repo offline')
      },
    } as unknown as Repository
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], brokenRepo, {})).toBeNull()
  })

  it('normalizes the plane normal', () => {
    const repo = repoReturning({ type: 'flatface', origin: [0, 0, 0], normal: [0, 0, 5] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut!.normal).toEqual([0, 0, 1])
  })

  it('reads the centroid when a registered plane carries no origin', () => {
    const repo = repoReturning({ type: 'flatface', centroid: [1, 2, 3], normal: [0, 0, 1] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [1, 2, 3], normal: [0, 0, 1] })
  })

  it('reads a point from its position fallback', () => {
    const repo = repoReturning({ position: [4, 5, 6] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [4, 5, 6], normal: [0, 0, 1] })
  })

  it('throws on a degenerate normal of a registered plane', () => {
    const repo = repoReturning({ type: 'flatface', origin: [0, 0, 0], normal: [0, 0, 0] })
    expect(() => resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})).toThrow(
      /degenerate normal on registered plane/,
    )
  })

  it('throws on a degenerate direction when resolving a point', () => {
    const repo = repoReturning({ point: [1, 2, 3] })
    expect(() => resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 0], repo, {})).toThrow(
      /degenerate direction vector/,
    )
  })

  it('returns null for a body-face ref whose body is missing or has no shape', () => {
    // A dangling face pick falls back to the blind distance rather than
    // crashing on the missing body's shape.
    const missing = repoReturning({ body_id: 'gone', face_index: 0 })
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], missing, {})).toBeNull()
    const shapeLess = repoReturning({ body_id: 'b1', face_index: 0 })
    const noShapeBody = { b1: { shape: null } } as unknown as Record<string, never>
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], shapeLess, noShapeBody)).toBeNull()
  })

  it('returns null for a payload that names no plane, face or point', () => {
    // An unrecognised registry payload falls back to the blind distance.
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repoReturning({ type: 'weird' }), {})).toBeNull()
  })

  it('resolves a planar body face through its OCC plane and normalizes the normal', () => {
    // Entry with body_id + face_index: the branch extracts the picked face from
    // the body shape and reads its surface plane. A non-unit surface normal must
    // come back normalized, not as raw OCC units.
    const table = { get: () => ({}) } as unknown as HandleTable
    const bodyStore = { body_b: { shape: 7 } } as unknown as Record<string, Body>
    vi.mocked(computeFacePlane).mockReturnValue({
      origin: [1, 2, 10], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 4],
    })
    const cut = resolveUpToPlane(noOcc, noScope, table, 'q', [0, 0, 1], repoReturning({ body_id: 'body_b', face_index: 2 }), bodyStore)
    expect(cut).toEqual({ origin: [1, 2, 10], normal: [0, 0, 1] })
    // The body shape must be resolved through the handle table and the picked
    // face index handed to extractOccFace, or the plane would come from the
    // wrong face regardless of the normal normalization.
    expect(vi.mocked(extractOccFace)).toHaveBeenCalledWith(noOcc, noScope, {}, 2)
  })

  it('throws for a non-planar body face instead of falling back to the blind distance', () => {
    // A curved face cannot define a cutting plane; reporting it as an unresolved
    // pick would quietly extrude the blind distance. The failure must be named.
    const table = { get: () => ({}) } as unknown as HandleTable
    const bodyStore = { body_b: { shape: 7 } } as unknown as Record<string, Body>
    vi.mocked(computeFacePlane).mockImplementation(() => {
      throw new Error('Only flat faces can be used as extrude profiles')
    })
    expect(() =>
      resolveUpToPlane(noOcc, noScope, table, 'q', [0, 0, 1], repoReturning({ body_id: 'body_b', face_index: 3 }), bodyStore),
    ).toThrow(/target face is not planar/)
  })
})

describe('trimAtPlane cap-face guard', () => {
  it('throws when the cap-face builder is not done rather than sweeping a null half-space', () => {
    // Face() on a not-done builder does not throw in this build, it returns a
    // NULL shape; sweeping that would make the Common below silently delete the
    // whole body, so the guard has to fail loud.
    class Poly {
      Add_1(): void {}
      Close(): void {}
      Wire(): object { return {} }
    }
    const oc = {
      BRepBuilderAPI_MakePolygon_1: Poly,
      gp_Pnt_3: class {},
      BRepBuilderAPI_MakeFace_15: class {
        IsDone(): boolean { return false }
      },
    } as unknown as OccModule
    const scope = { track: <T>(x: T): T => x } as unknown as DisposeScope
    expect(() =>
      trimAtPlane(oc, scope, {} as OccShape, { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1]),
    ).toThrow(/could not build a planar cap face/)
  })
})

describe('upToDistance', () => {
  it('is the signed distance to the plane along the direction', () => {
    expect(upToDistance({ origin: [0, 0, 7], normal: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeCloseTo(7)
    expect(upToDistance({ origin: [0, 0, -5], normal: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeCloseTo(-5)
  })
})

describe('orientToTarget', () => {
  const zPlane = (z: number): CutPlane => ({ origin: [0, 0, z], normal: [0, 0, 1] })

  // Componentwise, because negating a zero component yields -0.
  function expectDir(actual: number[], expected: number[]): void {
    for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i])
  }

  it('keeps the direction when the target is ahead', () => {
    expectDir(orientToTarget(zPlane(7), [0, 0, 0], [0, 0, 1]), [0, 0, 1])
  })

  it('reverses the direction when the target is behind', () => {
    expectDir(orientToTarget(zPlane(-5), [0, 0, 0], [0, 0, 1]), [0, 0, -1])
  })

  it('reverses a reversed direction back when the target is ahead of the profile', () => {
    expectDir(orientToTarget(zPlane(7), [0, 0, 0], [0, 0, -1]), [0, 0, 1])
  })

  it('works for an oblique direction and a tilted plane', () => {
    const s = Math.SQRT1_2
    const cut: CutPlane = { origin: [0, 0, -3], normal: [0, -s, s] }
    expectDir(orientToTarget(cut, [0, 0, 0], [0, s, s]), [0, -s, -s])
  })

  it('throws when the target passes through the profile', () => {
    expect(() => orientToTarget(zPlane(0), [0, 0, 0], [0, 0, 1])).toThrow(/no distance to extrude/)
  })

  it('throws when the target is beyond the modelled reach', () => {
    expect(() => orientToTarget(zPlane(1e6), [0, 0, 0], [0, 0, 1])).toThrow(/beyond reach/)
  })
})
