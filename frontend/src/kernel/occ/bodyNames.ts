// A body's construction names as arrays aligned to the canonical sub-shape
// order of its own shape (feature/query-uuid-handoff.md).
//
// The canonical order is TopExp_Explorer order deduped by IsSame. It is a
// position inside ONE shape at one moment: the producer writes the arrays while
// it holds the OCC shape, a consumer reads them on that same shape. An index is
// never stored in a query and never compared across two shapes. The order
// survives the only copies the pipeline makes between a producer and a
// consumer (`copyShape`, checkpoint restore), which
// `canonicalOrderCopyReal.test.ts` guards, so the arrays ride a copy unchanged.
//
// Inside a producer, names are keyed by sub-shape identity (`SubShapeMap`);
// `namesToArray` / `namesFromArray` are the only conversions between the two.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { SubShapeDedup, SubShapeIndexMap, SubShapeMap } from './subshapeIdentity'
import type { Body } from '../types3d'

/** One uuid (or null for an unnamed sub-shape) per canonical sub-shape. */
export type UuidArray = (string | null)[]

/**
 * A producer's construction names for the faces and edges of the shape it is
 * building, keyed by sub-shape identity, plus each UUID's ancestral tokens.
 * Entries keyed by a sub-shape the final shape does not contain are simply
 * never written to the body.
 */
export interface ShapeNames {
  faceNames: SubShapeMap<string>
  edgeNames: SubShapeMap<string>
  faceAncestry: Record<string, string[]>
  edgeAncestry: Record<string, string[]>
}

export function emptyShapeNames(): ShapeNames {
  return { faceNames: new SubShapeMap(), edgeNames: new SubShapeMap(), faceAncestry: {}, edgeAncestry: {} }
}

/** Add `from` into `into`, later entries winning: one shape's names onto another's. */
export function mergeShapeNames(into: ShapeNames, from: ShapeNames): ShapeNames {
  into.faceNames.assign(from.faceNames)
  into.edgeNames.assign(from.edgeNames)
  Object.assign(into.faceAncestry, from.faceAncestry)
  Object.assign(into.edgeAncestry, from.edgeAncestry)
  return into
}

/**
 * Face names carried across an operation by its face history: each output face
 * takes the name of the input face it came from (`origin`, one pair per output,
 * as `booleanWithHistory` reports it), the target's or the tool's. An input that
 * reached several outputs (a split) names none of them, since one UUID must
 * never name two faces; the caller's neighbour pass may name them instead.
 */
export function carryFaceNames(
  origin: readonly { output: OccSubShape; source: OccSubShape; fromTool: boolean }[],
  target: SubShapeMap<string>,
  tool: SubShapeMap<string> | null,
): SubShapeMap<string> {
  const reach = new SubShapeMap<number>()
  for (const o of origin) reach.set(o.source, (reach.get(o.source) ?? 0) + 1)
  const out = new SubShapeMap<string>()
  for (const o of origin) {
    if (reach.get(o.source)! > 1 || out.has(o.output)) continue
    const uuid = (o.fromTool ? tool : target)?.get(o.source)
    if (uuid) out.set(o.output, uuid)
  }
  return out
}

/** A body's stored names keyed by the sub-shapes of `shape`, the body's own shape. */
export function readBodyNames(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  body: Pick<Body, 'face_uuids' | 'edge_uuids' | 'face_ancestry' | 'edge_ancestry'>,
): ShapeNames {
  return {
    faceNames: namesFromArray(canonicalFaces(oc, scope, shape), body.face_uuids),
    edgeNames: namesFromArray(canonicalEdges(oc, scope, shape), body.edge_uuids),
    faceAncestry: { ...(body.face_ancestry ?? {}) },
    edgeAncestry: { ...(body.edge_ancestry ?? {}) },
  }
}

type Kind = 'FACE' | 'EDGE' | 'VERTEX'

/** The unique sub-shapes of `kind` in TopExp_Explorer order: the canonical order. */
function canonical(oc: OccModule, scope: DisposeScope, shape: OccShape, kind: Kind): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  // The typed downcast every face/edge/vertex reader's embind signature requires.
  const cast = kind === 'FACE' ? oc.TopoDS.Face_1 : kind === 'EDGE' ? oc.TopoDS.Edge_1 : oc.TopoDS.Vertex_1
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E[`TopAbs_${kind}`], E.TopAbs_SHAPE))
  const dedup = new SubShapeDedup()
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const s = scope.track(cast(scope.track(exp.Current()))) as OccSubShape
    if (dedup.add(s)) out.push(s)
  }
  return out
}

export function canonicalFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  return canonical(oc, scope, shape, 'FACE')
}

export function canonicalEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  return canonical(oc, scope, shape, 'EDGE')
}

export function canonicalVertices(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  return canonical(oc, scope, shape, 'VERTEX')
}

/** Identity -> canonical index over `subs`, for a consumer holding a sub-shape. */
export function canonicalIndex(subs: readonly OccSubShape[]): SubShapeIndexMap {
  const index = new SubShapeIndexMap()
  subs.forEach((s, i) => index.set(s, i))
  return index
}

/** The array a body stores: `names` read off `subs` in canonical order (all null without names). */
export function namesToArray(subs: readonly OccSubShape[], names: SubShapeMap<string> | null): UuidArray {
  return subs.map((s) => names?.get(s) ?? null)
}

/**
 * Refuse an array that cannot belong to `subs`. A length mismatch means the
 * body's shape was replaced without its names being rewritten, and reading on
 * would hand every sub-shape past the gap a neighbour's uuid: fail-wrong, so
 * it throws instead.
 */
export function assertAligned(count: number, uuids: readonly (string | null)[] | null | undefined, what: string): void {
  if (uuids != null && uuids.length !== count) {
    throw new Error(`${what}: ${uuids.length} names for ${count} sub-shapes; the names belong to another shape`)
  }
}

/** The identity-keyed names a producer works with, read off a body's array. */
export function namesFromArray(subs: readonly OccSubShape[], uuids: UuidArray | undefined): SubShapeMap<string> {
  const names = new SubShapeMap<string>()
  if (uuids === undefined) return names
  assertAligned(subs.length, uuids, 'namesFromArray')
  subs.forEach((s, i) => {
    const uuid = uuids[i]
    if (uuid) names.set(s, uuid)
  })
  return names
}
