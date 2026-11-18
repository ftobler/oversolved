/**
 * Every face's sort and frame facts in one call per shape.
 *
 * The render pass (`readShapeFaces`) and the metadata pass (`sortedFaceRows`)
 * need, per face, the surface type, the area centroid, the outward normal at
 * the UV midpoint, the analytic frame and a cylinder's dv axis. Read one reader
 * at a time that is up to four `BRepAdaptor_Surface` constructions per face plus
 * a proxy per gp_* accessor; on a freeform face the adaptor construction is the
 * cost. `OversolvedFaceFacts.Read` (an r3 build helper) builds one adaptor per
 * face in C++ and returns a flat table, read here back into the same values the
 * per-face readers in primitives.ts return, number for number
 * (faceFactsReal.test.ts pins the two equal on every surface kind).
 */

import type { OccModule, OccShape } from './occTypes'
import type { SurfaceFrame, SurfaceType, Vec3 } from './primitives'

/** One face's facts, in `TopExp_Explorer(shape, TopAbs_FACE)` order. */
export interface FaceFact {
  surfaceType: SurfaceType
  centroid: Vec3
  // The outward normal, or null where OCCT reports it undefined at the UV
  // midpoint; `factNormal` turns that into the per-face reader's refusal.
  normal: Vec3 | null
  surfaceFrame: SurfaceFrame | null
  // A cylinder's normalised dv at the UV midpoint; null otherwise or when dv
  // is degenerate (faceCylinderAxis).
  cylinderAxis: Vec3 | null
  // The raw GeomAbs_SurfaceType number, for the refusal message.
  geomType: number
}

// Slot layout of a row, fixed by the build (bindings/oversolved_mesh.cpp).
// The row width is read from the module, so only the offsets live here.
const TYPE = 0
const CENTROID = 1
const NORMAL = 5
const AXIS = 9
const ORIGIN = 12
const RADIUS = 15
const SEMI_ANGLE = 16
const MINOR_RADIUS = 17
const CYLINDER_DV = 18

function xyz(row: Float64Array, at: number): Vec3 {
  return [row[at], row[at + 1], row[at + 2]]
}

/** NaN in the first slot is the build's "absent" marker for a whole triple. */
function xyzOrNull(row: Float64Array, at: number): Vec3 | null {
  return Number.isNaN(row[at]) ? null : xyz(row, at)
}

function surfaceTypeOfGeom(oc: OccModule, t: number): SurfaceType {
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Plane.value) return 'flatface'
  if (t === S.GeomAbs_Cylinder.value) return 'cylinderface'
  if (t === S.GeomAbs_Cone.value) return 'coneface'
  if (t === S.GeomAbs_Sphere.value) return 'sphereface'
  if (t === S.GeomAbs_Torus.value) return 'torusface'
  return 'face'
}

/** The frame faceSurfaceFrame builds, with its key order, from one row. */
function frameOf(surfaceType: SurfaceType, row: Float64Array): SurfaceFrame | null {
  const axis = xyz(row, AXIS)
  const origin = xyz(row, ORIGIN)
  switch (surfaceType) {
    case 'cylinderface':
    case 'sphereface':
      return { axis, origin, radius: row[RADIUS] }
    case 'coneface':
      return { axis, origin, radius: row[RADIUS], semi_angle: row[SEMI_ANGLE] }
    case 'torusface':
      return { axis, origin, radius: row[RADIUS], minor_radius: row[MINOR_RADIUS] }
    default:
      return null
  }
}

/** Every face of `shape`, in explorer order, from one helper call. */
export function readFaceFacts(oc: OccModule, shape: OccShape): FaceFact[] {
  const stride = oc.OversolvedFaceFacts.Stride()
  const { faceCount, facts } = oc.OversolvedFaceFacts.Read(shape)
  const out: FaceFact[] = new Array(faceCount)
  for (let i = 0; i < faceCount; i++) {
    const row = facts.subarray(i * stride, (i + 1) * stride)
    const geomType = row[TYPE]
    const surfaceType = surfaceTypeOfGeom(oc, geomType)
    out[i] = {
      surfaceType,
      centroid: xyz(row, CENTROID),
      normal: xyzOrNull(row, NORMAL),
      surfaceFrame: frameOf(surfaceType, row),
      cylinderAxis: surfaceType === 'cylinderface' ? xyzOrNull(row, CYLINDER_DV) : null,
      geomType,
    }
  }
  return out
}

/**
 * The fact for the i-th explored face. A list read off another solid, or a
 * stale one, runs out or overruns here instead of silently pairing faces with
 * the wrong facts.
 */
export function factAt(facts: readonly FaceFact[], i: number): FaceFact {
  const fact = facts[i]
  if (fact === undefined) throw new Error(`face facts: no fact for face ${i} (${facts.length} read)`)
  return fact
}

/** After a walk over `count` faces: a longer list was read off another solid. */
export function assertFactCount(facts: readonly FaceFact[], count: number): void {
  if (facts.length !== count) throw new Error(`face facts: ${facts.length} read for ${count} faces`)
}

/** The face's normal, refused exactly as primitives.ts `faceNormal` refuses. */
export function factNormal(fact: FaceFact): Vec3 {
  if (fact.normal === null) {
    throw new Error(`faceNormal: normal is not defined at the UV midpoint (surface type ${fact.geomType})`)
  }
  return fact.normal
}
