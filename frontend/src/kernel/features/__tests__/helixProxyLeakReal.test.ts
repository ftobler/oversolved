// @vitest-environment node
//
// A helix's cylinder-face reference reads the surface through by-value gp_*
// accessors: `cyl.Axis()` hands back a fresh gp_Ax1, its `.Direction()` a
// gp_Dir, `cyl.Position()` a gp_Ax3 and its `.Location()` a gp_Pnt. Each owns
// WASM memory. The shipped solve tracked the gp_Ax3 (so that one was freed)
// and left the other three live for the whole worker session, one set per
// solve.
//
// The oc module is wrapped just enough to see the proxies those four accessors
// hand out; the solve itself is the real one, on a real cylinder body. After
// the solve scope is disposed, nothing the accessor chain produced may still be
// alive.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { sortedFacesOf } from '../../occ/faceLoops'
import { makeCylinderWithFaces } from '../../occ/primitives'
import { solveHelix } from '../helix'
import type { Disposable } from '../../occ/disposeScope'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'

const oc = await loadOcc()

// The by-value readers that return a fresh disposable proxy.
const ACCESSORS = new Set([
  'Axis', 'Position', 'Location', 'Direction', 'XDirection', 'YDirection', 'XAxis', 'YAxis',
])
// The surface readers that hand a gp_* out of a BRepAdaptor_Surface; the gp
// itself is a step on the chain, not one of the proxies under test.
const SURFACES = new Set(['Plane', 'Cylinder', 'Cone', 'Sphere', 'Torus'])

/** A copy of the oc module whose surface adaptor returns gp proxy chains that
 *  are recorded in `live` when an accessor hands one out. `delete()` removes
 *  it again, so a disposed scope empties the set. */
function recordingOcc(real: OccModule, live: Set<Disposable>): OccModule {
  const wrap = (target: object): object => {
    const cached = cache.get(target)
    if (cached !== undefined) return cached
    const proxy = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj)
        if (typeof value !== 'function') return value
        if (prop === 'delete') {
          return () => {
            live.delete(obj as Disposable)
            return (value as () => void).call(obj)
          }
        }
        const relays = typeof prop === 'string' && (ACCESSORS.has(prop) || SURFACES.has(prop))
        if (!relays) return (value as (...a: unknown[]) => unknown).bind(obj)
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(obj, args)
          if (out === null || typeof out !== 'object') return out
          if (ACCESSORS.has(prop as string)) live.add(out as Disposable)
          return wrap(out)
        }
      },
    })
    cache.set(target, proxy)
    return proxy
  }
  const cache = new WeakMap<object, object>()
  const clone = { ...real } as unknown as Record<string, unknown>
  const adaptor = clone.BRepAdaptor_Surface_2 as new (...args: unknown[]) => object
  clone.BRepAdaptor_Surface_2 = new Proxy(adaptor, {
    construct(target, args, newTarget) {
      return wrap(Reflect.construct(target, args, newTarget))
    },
  })
  return clone as unknown as OccModule
}

describe.skipIf(!oc)('a helix reference frees its gp proxies (real OCC)', () => {
  it('leaves no live accessor proxy after the solve scope is disposed', () => {
    const live = new Set<Disposable>()
    const occ = recordingOcc(oc!, live)
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const { shape, faces } = makeCylinderWithFaces(occ, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const handle = table.register(shape, 'ex1')
      const body: Body = {
        id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: handle,
        sketch_id: 'sk1', brep_diff: null, profile_queries: [],
      }
      const bodyStore: Record<string, Body> = { body_ex1: body }
      const index = sortedFacesOf(occ, scope, shape)
        .findIndex((f) => (f as OccShape & { IsSame(o: OccShape): boolean }).IsSame(faces.lateral))
      repo.register('cf', {
        type: 'cylinderface', body_id: 'body_ex1', face_index: index,
        axis: [0, 0, 1], centroid: [0, 0, 5], normal: [1, 0, 0],
      })

      const result = solveHelix(occ, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: {
          reference: '@cf', radius_mode: 'derived', mode: 'pitch_height', pitch: 2,
          height_from_reference: true, hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
        },
      }, repo, bodyStore)
      expect(result.status).toBe('ok')
      // The accessor chain ran: without it this test would pass vacuously.
      expect(live.size).toBeGreaterThan(0)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
    expect([...live]).toEqual([])
  })
})
