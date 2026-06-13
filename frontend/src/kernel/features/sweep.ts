// Port of `_solve_sweep` (solver_features_brep.py): the sweep leaf. It resolves
// the profile to 2D loops (face profiles are not supported for sweep), resolves
// the path reference to an ordered chain of world-space spine edges, sweeps the
// profile's outer boundary along the spine with per-entity lineage, and applies
// the body operation. Includes the path-collection helpers (_path_ref_to_sketch_id,
// _order_edges_into_chain, _world_arc_edge, _collect_path_edges).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { parseAncestry } from '../query'
import { collectExtrudeLoops } from './faceProfile'
import { sketchToWorld2d, extractProfileLoops, type PlaneLike } from './shared'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { sweepProfileWithLineage } from '../occ/prismLineage'
import { makeLineEdge, makeArcEdge, type Vec3 } from '../occ/primitives'

type Dict = Record<string, unknown>
type Lineage = Record<string, string[]>

export interface SweepResult {
  [key: string]: unknown
  status: string
  body_id: string
}

/** Structural (non-index) entity tokens of a `?...` surface query, sorted. */
function surfaceEntityIds(surface: Dict): string[] {
  const query = (surface.query as string) ?? ''
  if (!query.startsWith('?')) return []
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return []
  }
  return [...new Set(ids.filter((i) => i.startsWith('@') && i.includes('/')))].sort()
}

/**
 * Normalize a sweep profile reference. A viewport `entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>` selection ID identifies a single sketch
 * entity; the profile is its parent sketch, so return the bare sketch id (which
 * collectExtrudeLoops resolves like a plain `$sketch` ref). All other ref forms
 * (`$`, `@`, `?`, bare ids) pass through unchanged.
 */
export function profileRefToSketchRef(ref: string): string {
  if (ref.startsWith('entity:') || ref.startsWith('vertex:')) {
    return ref.split(':')[1]
  }
  return ref
}

/** Resolve a sweep path reference to the sketch id holding the spine. */
export function pathRefToSketchId(pathRef: string, globalRepo: Repository): string {
  if (pathRef.startsWith('@')) return pathRef.slice(1).split('/')[0]
  if (pathRef.startsWith('?')) {
    const [ids] = parseAncestry(pathRef)
    for (const aid of ids) {
      if (aid.startsWith('@') && !aid.includes('/')) {
        const cand = aid.slice(1)
        if (
          globalRepo.elements.get('_topo_' + cand) !== undefined ||
          globalRepo.elements.get('_pt_' + cand) !== undefined
        ) {
          return cand
        }
      }
    }
    throw new Error(`sweep: could not resolve path sketch from ${JSON.stringify(pathRef)}`)
  }
  return pathRef.replace(/^\$+/, '')
}

/**
 * Order path edges into a connected chain by matching endpoints (mirrors
 * `_order_edges_into_chain`). Geometry is orientation-independent for wire
 * assembly, so only the sequence matters. Throws if not one connected chain.
 * Endpoints are compared component-wise across all dimensions, so this works
 * for both 2D sketch points and 3D world points (a path spanning sketches on
 * different planes is ordered in world space).
 */
export function orderEdgesIntoChain(edges: Dict[], tol = 1e-6): Dict[] {
  const close = (a: number[], b: number[]): boolean => {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= tol) return false
    }
    return true
  }

  if (edges.length <= 1) return [...edges]

  const endpoints: number[][] = []
  for (const e of edges) {
    endpoints.push(e.start as number[])
    endpoints.push(e.end as number[])
  }
  const degree = (p: number[]): number => endpoints.filter((q) => close(p, q)).length

  const used = new Array(edges.length).fill(false)
  let startI = 0
  let curPt = edges[0].end as number[]
  for (let i = 0; i < edges.length; i++) {
    if (degree(edges[i].start as number[]) === 1) {
      startI = i
      curPt = edges[i].end as number[]
      break
    }
    if (degree(edges[i].end as number[]) === 1) {
      startI = i
      curPt = edges[i].start as number[]
      break
    }
  }

  const ordered: Dict[] = [edges[startI]]
  used[startI] = true
  for (let k = 0; k < edges.length - 1; k++) {
    let found = false
    for (let j = 0; j < edges.length; j++) {
      if (used[j]) continue
      const e = edges[j]
      if (close(e.start as number[], curPt)) {
        ordered.push(e)
        used[j] = true
        curPt = e.end as number[]
        found = true
        break
      }
      if (close(e.end as number[], curPt)) {
        ordered.push(e)
        used[j] = true
        curPt = e.start as number[]
        found = true
        break
      }
    }
    if (!found) throw new Error('sweep: path edges do not form a connected chain')
  }
  return ordered
}

/**
 * Build a world-space minor circular arc edge through start -> end about center
 * (mirrors `_world_arc_edge`). The rotation plane comes from the start/end radius
 * vectors; major arcs (>180 degrees) are not supported.
 */
export function worldArcEdge(
  oc: OccModule,
  scope: DisposeScope,
  center: number[],
  start: number[],
  end: number[],
  radius: number,
): OccShape {
  let v0 = [start[0] - center[0], start[1] - center[1], start[2] - center[2]]
  let v1 = [end[0] - center[0], end[1] - center[1], end[2] - center[2]]

  // Snap to exact radius: solver output may have |v0| or |v1| off by 1e-9.
  // Normalizing prevents the arc edge from drifting off the nominal circle,
  // which would create a second-order gap at the joints.  The residual gap
  // (snapped arc endpoint vs. raw line endpoint) is healed by makeWire.
  const v0Mag = Math.sqrt(v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2])
  const v1Mag = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2])
  if (Math.abs(v0Mag - radius) > 1e-9 || Math.abs(v1Mag - radius) > 1e-9) {
    v0 = [v0[0] / v0Mag * radius, v0[1] / v0Mag * radius, v0[2] / v0Mag * radius]
    v1 = [v1[0] / v1Mag * radius, v1[1] / v1Mag * radius, v1[2] / v1Mag * radius]
  }

  const cross = [
    v0[1] * v1[2] - v0[2] * v1[1],
    v0[2] * v1[0] - v0[0] * v1[2],
    v0[0] * v1[1] - v0[1] * v1[0],
  ]
  const crossMag = Math.sqrt(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2])
  if (crossMag < 1e-12) throw new Error('sweep: degenerate or 180-degree arc in path not supported')
  const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
  const angle = Math.atan2(crossMag, dot)
  const normal: Vec3 = [cross[0] / crossMag, cross[1] / crossMag, cross[2] / crossMag]
  return makeArcEdge(oc, scope, center as Vec3, normal, v0 as Vec3, radius, 0.0, angle)
}

/**
 * Split a sketch-entity selection ref (`entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>`) into its sketch id and entity id. Returns a
 * null `eid` for any other ref form (the whole sketch is selected).
 */
function refToSketchAndEntity(ref: string, globalRepo: Repository): { sketchId: string; eid: string | null } {
  if (ref.startsWith('entity:') || ref.startsWith('vertex:')) {
    const parts = ref.split(':')
    return { sketchId: parts[1], eid: parts[2] ?? null }
  }
  return { sketchId: pathRefToSketchId(ref, globalRepo), eid: null }
}

/**
 * Collect the world-space topo edges a single path ref contributes. An
 * `entity:`/`vertex:` ref selects only the edges of that one sketch entity
 * (edge-precise); any other ref selects every edge of the sketch. Edges carry
 * their world-space start/end (and center for arcs) so a path spanning sketches
 * on different planes orders correctly. Returns [worldEdges, sketchId].
 */
function pathRefWorldEdges(ref: string, globalRepo: Repository): [Dict[], string] {
  const { sketchId, eid } = refToSketchAndEntity(ref, globalRepo)
  const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (plane === undefined) throw new Error(`sweep: path sketch not found: ${JSON.stringify(sketchId)}`)
  const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
  const rawEdges = (topo.edges as Dict[]) ?? []
  const selected = eid === null ? rawEdges : rawEdges.filter((e) => e.entity_id === eid)

  const worldEdges: Dict[] = []
  for (const e of selected) {
    const we: Dict = {
      kind: e.kind,
      edge_index: e.edge_index,
      start: sketchToWorld2d(e.start as number[], plane),
      end: sketchToWorld2d(e.end as number[], plane),
    }
    if (e.kind === 'arc' && 'center' in e) {
      we.center = sketchToWorld2d(e.center as number[], plane)
      we.radius = Number(e.radius)
    }
    worldEdges.push(we)
  }
  return [worldEdges, sketchId]
}

/**
 * Gather one or more sweep path references into a single ordered chain of
 * world-space edge descriptors (the OCC-free core of `_collect_path_edges`,
 * extended for multi-pick / edge-precise selection). Edges shared between refs
 * are deduped, and the whole set must form one connected chain. Returns
 * [orderedWorldEdges, firstPathSketchId].
 */
export function orderedPathWorldEdges(
  pathRefs: string | string[],
  globalRepo: Repository,
): [Dict[], string] {
  const refs = Array.isArray(pathRefs) ? pathRefs : [pathRefs]
  const worldEdges: Dict[] = []
  const seen = new Set<string>()  // dedupe edges shared between refs (sketch + index)
  let firstSketchId = ''
  for (const ref of refs) {
    const [edges, sketchId] = pathRefWorldEdges(ref, globalRepo)
    if (!firstSketchId) firstSketchId = sketchId
    for (const e of edges) {
      const key = sketchId + ':' + String(e.edge_index)
      if (seen.has(key)) continue
      seen.add(key)
      worldEdges.push(e)
    }
  }
  if (worldEdges.length === 0) throw new Error('sweep: path has no edges')
  return [orderEdgesIntoChain(worldEdges), firstSketchId]
}

/**
 * Resolve one or more sweep path references to ordered world-space spine edges
 * (mirrors `_collect_path_edges`, extended for multi-pick / edge-precise
 * selection). All contributed edges must form one connected chain. Returns
 * [spineEdges, firstPathSketchId].
 */
export function collectPathEdges(
  oc: OccModule,
  scope: DisposeScope,
  pathRefs: string | string[],
  globalRepo: Repository,
): [OccShape[], string] {
  const [ordered, firstSketchId] = orderedPathWorldEdges(pathRefs, globalRepo)
  const spineEdges: OccShape[] = []
  for (const e of ordered) {
    if (e.kind === 'arc' && 'center' in e) {
      spineEdges.push(
        worldArcEdge(oc, scope, e.center as number[], e.start as number[], e.end as number[], Number(e.radius)),
      )
    } else {
      spineEdges.push(makeLineEdge(oc, scope, e.start as Vec3, e.end as Vec3))
    }
  }
  return [spineEdges, firstSketchId]
}

/** Solve a sweep feature into the body store (mirrors `_solve_sweep`). */
export function solveSweep(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): SweepResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.sweep as Dict) ?? {}
  const mergeTarget = ((sub.merge_target as string) ?? (feature.merge_target as string)) ?? null
  const merged: Dict = { ...sub, ...feature }

  const sketchRaw = merged.sketch
  const rawRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  const pathRaw = merged.path
  const pathRefs: string[] = Array.isArray(pathRaw)
    ? (pathRaw as string[]).filter((s) => s)
    : pathRaw
      ? [pathRaw as string]
      : []

  if (rawRefs.length === 0) throw new Error('sweep: requires at least one profile reference')
  if (pathRefs.length === 0) throw new Error('sweep: requires a path reference')

  // Partition profile refs. `entity:`/`vertex:` picks are edge-precise: only the
  // picked entity's edges contribute, and several picks on one sketch assemble
  // into a single loop. Region/sketch refs (`?`/`@`/`$`) keep routing through
  // collectExtrudeLoops, where face/region matching is already precise.
  const entityEidsBySketch = new Map<string, Set<string>>()
  const regionRefs: string[] = []
  for (const ref of rawRefs) {
    if (ref.startsWith('entity:') || ref.startsWith('vertex:')) {
      const parts = ref.split(':')
      const sk = parts[1]
      let set = entityEidsBySketch.get(sk)
      if (!set) {
        set = new Set()
        entityEidsBySketch.set(sk, set)
      }
      if (parts[2]) set.add(parts[2])
    } else {
      regionRefs.push(ref)
    }
  }

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const faceLineage: Lineage = {}
  const edgeLineage: Lineage = {}

  for (const sketchRef of [...new Set(regionRefs)]) {
    let resolved
    try {
      resolved = collectExtrudeLoops(oc, scope, table, sketchRef, featureId, 0.0, globalRepo, bodyStore)
    } catch (exc) {
      profileErrors.push(exc instanceof Error ? exc.message : String(exc))
      continue
    }
    if (resolved.face !== null) {
      cqFaces.push(resolved.face)
    } else {
      allLoops.push(...resolved.loops)
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = resolved.plane
      firstSketchId = resolved.sketchId
    }
  }

  // Edge-precise profiles: assemble the picked entities' topo edges into closed
  // loops (the same endpoint chaining collectExtrudeLoops uses for surfaces).
  for (const [sketchId, eids] of entityEidsBySketch) {
    const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
    if (plane === undefined) {
      profileErrors.push(`sketch not found: ${sketchId}`)
      continue
    }
    const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
    const edges = ((topo.edges as Dict[]) ?? []).filter((e) => eids.has(e.entity_id as string))
    const loops = extractProfileLoops([{ boundary: edges }])
    if (loops.length === 0) {
      profileErrors.push(`sweep: picked profile edges do not form a closed loop (sketch ${sketchId})`)
      continue
    }
    allLoops.push(...loops)
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = plane
      firstSketchId = sketchId
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }
  if (cqFaces.length > 0 && allLoops.length === 0) {
    throw new Error('sweep: face profiles are not yet supported; use a sketch profile')
  }
  if (allLoops.length === 0) throw new Error('sweep: no closed profile found')

  const [spineEdges] = collectPathEdges(oc, scope, pathRefs, globalRepo)

  const bodyId = 'body_' + featureId
  const result: SweepResult = { status: 'ok', body_id: bodyId }
  const operation = ((merged.operation as string) ?? 'add') as BodyOperation

  const lineage = sweepProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, spineEdges, firstSketchId)
  Object.assign(faceLineage, lineage.faceLineage)
  Object.assign(edgeLineage, lineage.edgeLineage)

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape: lineage.solid,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId: firstSketchId,
    opName: 'sweep',
    profileQueries,
    faceLineage,
    edgeLineage,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }

  return result
}
