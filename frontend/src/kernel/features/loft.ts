// The loft leaf: build a solid through two or more sketch profiles on
// (usually) different planes, ruled or smooth. Each profile is resolved with
// the same collector extrude uses (collectExtrudeLoops), so a whole sketch, a
// picked area, a sketch entity or a planar body face all work as a section; the
// section's OUTER boundary becomes the wire ThruSections lofts through, exactly
// as the sweep leaf only carries the outer boundary of its profile (holes in a
// loft section are not carried through the surface).
//
// One section must be one closed region: a sketch area that resolves to several
// separate regions is refused by name, because there is no way to say which
// region continues into which. Section order is the authored profile order, and
// the first/last section cap the solid: `cap|start`/`cap|end` follow that order,
// never the world axis, so a reordered profile list is a different (still
// named) solid.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import type { LoftFeature } from '@/types/cad'
import { extractErrorMessage } from '../errors'
import { healWire } from '../occ/primitives'
import { classifyLoops, type LoopEdge } from '../profileLoops'
import { sketchLoopsToFace } from '../occ/prismProfile'
import { applyLoftWithLineage, type LoftSection } from '../occ/loftShape'
import { collectExtrudeLoops } from './faceProfile'
import { surfaceEntityIds } from './shared/bodyRef'
import { applyBodyOperation, type BodyOperation } from './bodyOps'

interface LoftResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids?: string[]
  exception?: string
}

/** The outer boundary wire of a section's face, healed so a solver-precision
 *  joint cannot make ThruSections refuse the section. */
function wireOfFace(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape {
  const raw = scope.track(oc.BRepTools.OuterWire(face))
  const wire = scope.track(healWire(oc, scope, raw))
  scope.release(raw)
  return wire
}

/**
 * Solve a loft feature (the generator `KIND_SOLVER.loft` dispatches to). It
 * resolves every profile to a section, lofts through them, and applies the body
 * operation (new/add/cut) through the shared dispatcher. Throws for the errors
 * the builder turns into an `exception` status: fewer than two profiles, a
 * profile that resolves to no closed region or to several regions, a profile
 * that fails to resolve, or a kernel refusal (incompatible sections), which
 * leaves the store unchanged.
 */
export function solveLoft(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: LoftFeature,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): LoftResult {
  const featureId = feature.id ?? ''
  const sub = feature.loft ?? {}
  const profiles = sub.profiles ?? []
  if (profiles.length < 2) {
    throw new Error('loft: at least two profiles are required')
  }
  const ruled = sub.ruled === true

  const sections: LoftSection[] = []
  const failed: string[] = []
  profiles.forEach((ref, index) => {
    if (!ref) {
      failed.push(`profiles[${index}]: empty profile reference`)
      return
    }
    let resolved: ReturnType<typeof collectExtrudeLoops>
    try {
      resolved = collectExtrudeLoops(oc, scope, table, ref, globalRepo, bodyStore)
    } catch (e) {
      failed.push(`profiles[${index}] ('${ref}'): ${extractErrorMessage(e)}`)
      return
    }

    let loops: LoopEdge[][]
    if (resolved.face === null) {
      const groups = classifyLoops(resolved.loops)
      if (groups.length === 0) {
        failed.push(`profiles[${index}] ('${ref}'): no closed region`)
        return
      }
      if (groups.length > 1) {
        failed.push(
          `profiles[${index}] ('${ref}'): ${groups.length} separate regions; ` +
          'a loft section must be one closed region',
        )
        return
      }
      loops = [groups[0][0], ...groups[0][1]]
    } else {
      loops = []
    }

    const face = resolved.face ?? scope.track(sketchLoopsToFace(oc, scope, loops, resolved.plane))
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as { surfaces?: unknown[] } | undefined) ?? {}
    sections.push({
      wire: wireOfFace(oc, scope, face),
      loops,
      plane: resolved.plane,
      sketchId: resolved.face === null ? resolved.sketchId : '',
      profileQueries: ((topo.surfaces as unknown[]) ?? []).flatMap((s) => surfaceEntityIds(s as never)),
    })
  })

  if (failed.length > 0) {
    throw new Error(`loft: ${failed.join('; ')}`)
  }

  const res = applyLoftWithLineage(oc, scope, sections, ruled, featureId)
  if (!res.success || res.shape === null) {
    throw new Error(`loft: ${res.reason ?? 'unknown failure'}`)
  }

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape: scope.track(res.shape),
    bodyStore,
    operation: (sub.operation ?? 'new') as BodyOperation,
    mergeTarget: sub.merge_target ?? null,
    bodyId: 'body_' + featureId,
    featureId,
    sketchId: sections[0].sketchId,
    opName: 'loft',
    profileQueries: sections.flatMap((s) => s.profileQueries),
    faceNames: res.names?.faceNames ?? null,
    edgeNames: res.names?.edgeNames ?? null,
    faceAncestry: res.names?.faceAncestry ?? null,
    edgeAncestry: res.names?.edgeAncestry ?? null,
  })
  return { ...opResult }
}
