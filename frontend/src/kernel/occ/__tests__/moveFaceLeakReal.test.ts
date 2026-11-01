// @vitest-environment node
//
// Every builder a move face constructs is owned at creation. The slab and the
// extended neighbour faces were built as `scope.track(new oc.MakeFace(..).Face())`,
// which tracks the face but strands the builder that made it: one builder per
// slab, per extended neighbour, per edit, for the whole worker session.
//
// The real OCC oc module is wrapped thinly so the three MakeFace constructors
// record what they created; the test then asks the scope whether it owns each
// one. Real geometry on purpose: a box top (planar slab + planar neighbours)
// and a cylinder top (planar slab + a cylindrical neighbour).
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { canonicalFaces } from '../bodyNames'
import { makeBox, makeCylinder, faceNormal, type Vec3 } from '../primitives'
import { applyMoveFace, neighbourSurface } from '../moveFace'
import type { Disposable } from '../disposeScope'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const MAKE_FACE_KINDS = ['BRepBuilderAPI_MakeFace_9', 'BRepBuilderAPI_MakeFace_10', 'BRepBuilderAPI_MakeFace_11']

/** A shallow copy of the oc module with the MakeFace constructors recorded.
 *  Copying (rather than proxying the module) keeps every binding's identity,
 *  including the enum tables that hang static properties off a constructor
 *  function. The emscripten bindings are closure-based, so losing `this` on a
 *  copy is harmless. */
function recordingOcc(real: OccModule, created: Disposable[]): OccModule {
  const clone = { ...real } as unknown as Record<string, unknown>
  for (const kind of MAKE_FACE_KINDS) {
    const ctor = clone[kind] as new (...args: unknown[]) => Disposable
    clone[kind] = new Proxy(ctor, {
      construct(target, args, newTarget) {
        const built = Reflect.construct(target, args, newTarget) as Disposable
        created.push(built)
        return built
      },
    })
  }
  return clone as unknown as OccModule
}

function facesMatching(occ: OccModule, scope: DisposeScope, body: OccShape, normal: Vec3): OccShape {
  for (const f of canonicalFaces(occ, scope, body)) {
    const n = faceNormal(occ, scope, f as OccShape)
    if (Math.abs(n[0] - normal[0]) < 1e-9 && Math.abs(n[1] - normal[1]) < 1e-9 && Math.abs(n[2] - normal[2]) < 1e-9) {
      return f as OccShape
    }
  }
  throw new Error('no face matched the normal')
}

describe.skipIf(!oc)('a move face owns every builder it makes (real OCC)', () => {
  it('tracks the slab and neighbour MakeFace builders on a box top', () => {
    const created: Disposable[] = []
    const occ = recordingOcc(oc!, created)
    const scope = new DisposeScope()
    try {
      const body = scope.track(makeBox(occ, scope, 10, 10, 10))
      const top = facesMatching(occ, scope, body, [0, 0, 1])
      scope.track(applyMoveFace(occ, scope, body, top, 5).shape)
      expect(created.length).toBeGreaterThan(0)
      for (const builder of created) expect(scope.isTracked(builder)).toBe(true)
    } finally {
      scope.dispose()
    }
    // Zero live handles: the scope owned the builders, so dispose deleted them.
    expect(scope.size()).toBe(0)
    for (const builder of created) expect(builder.isDeleted?.() ?? true).toBe(true)
  })

  it('tracks the cylindrical neighbour builder too', () => {
    const created: Disposable[] = []
    const occ = recordingOcc(oc!, created)
    const scope = new DisposeScope()
    try {
      const body = scope.track(makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 5, 10))
      const lateral = canonicalFaces(occ, scope, body)
        .find((f) => neighbourSurface(occ, scope, f as OccShape) === 'cylinder') as OccShape
      expect(lateral).toBeDefined()
      scope.track(applyMoveFace(occ, scope, body, lateral, 2).shape)
      expect(created.length).toBeGreaterThan(0)
      for (const builder of created) expect(scope.isTracked(builder)).toBe(true)
    } finally {
      scope.dispose()
    }
    expect(scope.size()).toBe(0)
  })
})
