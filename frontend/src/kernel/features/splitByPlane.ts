// The split leaf: cut one or more bodies with a plane and keep the side above
// it, the side below it, or both sides as separate bodies.
//
// The tool is a finite box covering one side of the plane (occ/halfSpace.ts),
// cut through the ordinary history-aware boolean pipeline. `above` is the side
// the plane's normal points to; a picked planar face's normal is the face's
// OUTWARD normal, so `above` there is the air side of that face.
//
// Every body is computed before any body is re-seated, and a body the plane
// misses is an exception rather than a silent skip: a split that keeps nothing
// is an authoring error (a plane edited past the body), so the row goes red and
// the body is left exactly as it was.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { SplitFeatureDef, SplitKeep } from '@/types/cad'
import type { Repository } from '../query'
import type { ShapeNames } from '../occ/bodyNames'
import type { FaceOrigin } from '../occ/booleans'
import { readBodyNames } from '../occ/bodyNames'
import { booleanWithDiff, exploreSolids, volumeOf } from '../occ/booleans'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { makeHalfSpaceBox } from '../occ/halfSpace'
import { mintFaceUuid, splitPlaneFacePath, type SplitSide } from '../constructionName'
import { resolveBodyRefList } from './shared/bodyResolution'
import { resolvePlaneRef } from './shared/planes'
import { transferBooleanNames } from './booleanLineage'
import { resplitBody } from './bodySplit'

const KEEP_VALUES: readonly SplitKeep[] = ['above', 'below', 'both']

export interface SplitResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
}

// One cut of one body against one half-space box.
interface HalfCut {
  side: SplitSide
  shape: OccShape
  diff: BrepDiff
  faceOrigin: FaceOrigin[]
  // The box face that becomes this half's cap, named by the transfer.
  base: OccSubShape
}

// Everything a body needs before any store mutation, so a later failure cannot
// leave the earlier bodies half applied.
interface SplitPlan {
  body: Body
  names: ShapeNames
  above: HalfCut | null
  below: HalfCut | null
}

function keepOf(cfg: Partial<SplitFeatureDef>): SplitKeep {
  const raw = cfg.keep
  if (raw === undefined || raw === null) return 'above'
  if (typeof raw === 'string' && (KEEP_VALUES as readonly string[]).includes(raw)) return raw as SplitKeep
  throw new Error(
    `split: unknown keep value ${JSON.stringify(raw)}; use one of ${KEEP_VALUES.map((v) => `"${v}"`).join(', ')}`,
  )
}

function capName(featureId: string, side: SplitSide): string {
  return mintFaceUuid(splitPlaneFacePath(featureId, side))
}

/**
 * Refuse a tool face that reached the result without being a box base. Every
 * wall and the far face of a half-space box must be outside the body, so seeing
 * one in the history means the box was too small and the cap would be named off
 * the wrong face. Internal by construction; a user cannot cause it.
 */
function assertOnlyBaseToolFaces(faceOrigin: FaceOrigin[], bases: SubShapeMap<string>, bodyId: string): void {
  for (const origin of faceOrigin) {
    if (!origin.fromTool) continue
    if (!bases.has(origin.source)) {
      throw new Error(
        `split: internal: the half-space box for body '${bodyId}' was too small ` +
        '(a tool face other than its base reached the result)',
      )
    }
  }
}

/**
 * Solve a split feature. Throws for every authoring error the builder turns
 * into an exception status: no bodies, no plane, an unknown keep value, a body
 * the plane misses, or a kept side with no material.
 */
export function solveSplit(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: { id?: string; split?: Partial<SplitFeatureDef> },
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): SplitResult {
  const featureId = feature.id ?? ''
  const cfg = feature.split ?? {}
  const keep = keepOf(cfg)

  const bodyQueries = cfg.bodies ?? []
  if (bodyQueries.length === 0) throw new Error('split: no bodies picked')
  const planeQuery = cfg.plane ?? ''
  if (!planeQuery) throw new Error('split: plane is required')
  const { origin, normal } = resolvePlaneRef(globalRepo, planeQuery, bodyStore, 'split')

  // Resolve every target before touching a shape, so a bad ref fails the whole
  // feature instead of after some bodies were already split.
  const targets = resolveBodyRefList(bodyQueries, globalRepo, bodyStore, 'split')

  const plans: SplitPlan[] = targets.map((key) => {
    const body = bodyStore[key]
    if (body === undefined) throw new Error(`split: body no longer exists: ${JSON.stringify(key)}`)
    if (body.shape === null) throw new Error(`split: body has no shape: ${JSON.stringify(key)}`)
    const shape = table.get<OccShape>(body.shape)
    const names = readBodyNames(oc, scope, shape, body)
    const sourceVolume = Math.abs(volumeOf(oc, scope, shape))
    const unifyFaces = !body.imported

    // `above` keeps the normal side, so it cuts away a box on the opposite
    // normal and its cap is that box's base; `below` is the mirror image.
    const cutAbove = keep === 'above' || keep === 'both'
    const cutBelow = keep === 'below' || keep === 'both'
    const cut = (side: SplitSide): HalfCut => {
      const boxNormal: [number, number, number] = side === 'above'
        ? [-normal[0], -normal[1], -normal[2]]
        : [normal[0], normal[1], normal[2]]
      const box = makeHalfSpaceBox(oc, scope, origin, boxNormal, shape)
      const res = booleanWithDiff(oc, scope, shape, box.shape, 'cut', { unifyFaces })
      return {
        side,
        shape: scope.track(res.shape),
        diff: res.diff,
        faceOrigin: res.faceOrigin,
        base: box.base as OccSubShape,
      }
    }
    const above = cutAbove ? cut('above') : null
    const below = cutBelow ? cut('below') : null

    const epsilon = 1e-9 * sourceVolume
    const aboveVolume = above === null ? 0 : Math.abs(volumeOf(oc, scope, above.shape))
    const belowVolume = below === null ? 0 : Math.abs(volumeOf(oc, scope, below.shape))

    if (keep === 'both') {
      if (aboveVolume <= epsilon || belowVolume <= epsilon) {
        throw new Error(`split: the plane does not cross body '${key}'`)
      }
      const sum = aboveVolume + belowVolume
      if (Math.abs(sum - sourceVolume) > 1e-6 * sourceVolume) {
        throw new Error(
          `split: the halves of body '${key}' do not add up (${aboveVolume} + ${belowVolume} = ${sum}, ` +
          `the body is ${sourceVolume})`,
        )
      }
    } else {
      const side: SplitSide = keep === 'below' ? 'below' : 'above'
      const kept = side === 'above' ? aboveVolume : belowVolume
      if (kept <= epsilon) {
        throw new Error(`split: nothing of body '${key}' lies ${side} the plane`)
      }
      if (Math.abs(kept - sourceVolume) <= epsilon) {
        throw new Error(`split: the plane does not cross body '${key}'`)
      }
    }

    const bases = new SubShapeMap<string>()
    if (above !== null) bases.set(above.base, capName(featureId, 'above'))
    if (below !== null) bases.set(below.base, capName(featureId, 'below'))
    if (above !== null) assertOnlyBaseToolFaces(above.faceOrigin, bases, key)
    if (below !== null) assertOnlyBaseToolFaces(below.faceOrigin, bases, key)

    return { body, names, above, below }
  })

  // Second pass: every body passed its guards, so the store may now change.
  const allIds: string[] = []
  for (const plan of plans) {
    const { body, names } = plan
    const ids = keep === 'both'
      ? applyBoth(oc, scope, table, bodyStore, body, names, plan.above as HalfCut, plan.below as HalfCut, featureId)
      : applyOne(oc, scope, table, bodyStore, body, names, (keep === 'below' ? plan.below : plan.above) as HalfCut, featureId)
    body.modified_by.push(featureId)
    allIds.push(...ids)
  }

  return { status: 'ok', body_id: allIds[0], body_ids: allIds, operation: keep }
}

/** Names for a cut's result: the target's faces carry verbatim, each box base
 *  becomes its side's cap. */
function transferFor(
  oc: OccModule,
  scope: DisposeScope,
  names: ShapeNames,
  bodyShape: OccShape,
  faceOrigin: FaceOrigin[],
  toolFaceNames: SubShapeMap<string>,
): ShapeNames {
  return transferBooleanNames(oc, scope, {
    bodyShape,
    faceOrigin,
    targetFaceNames: names.faceNames,
    targetFaceAncestry: names.faceAncestry,
    targetCapAncestry: names.capAncestry,
    toolFaceNames,
    toolFaceAncestry: {},
    toolCapAncestry: {},
    // The box is this cut's own tool, never a kept body, so the cap UUIDs are
    // already unique to the split and carry verbatim.
    toolUuidScope: null,
  })
}

function applyOne(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  body: Body,
  names: ShapeNames,
  cut: HalfCut,
  featureId: string,
): string[] {
  const toolFaceNames = new SubShapeMap<string>()
  toolFaceNames.set(cut.base, capName(featureId, cut.side))
  const produced = transferFor(oc, scope, names, cut.shape, cut.faceOrigin, toolFaceNames)
  // `cut.shape` is already tracked by the plan's scope, so it is handed over
  // as-is: tracking it again would delete the same proxy twice.
  const ids = resplitBody(oc, scope, table, bodyStore, body, cut.shape, featureId, produced)
  body.brep_diff = cut.diff
  return ids
}

function applyBoth(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  body: Body,
  names: ShapeNames,
  above: HalfCut,
  below: HalfCut,
  featureId: string,
): string[] {
  // One transfer over both halves together: a face the plane crosses has one
  // output in each half, and two separate transfers would hand that face's UUID
  // to both. One call makes it a genuine split and names the children.
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound as never)
  for (const cut of [above, below]) {
    for (const solid of exploreSolids(oc, scope, cut.shape)) builder.Add(compound as never, solid)
  }
  const toolFaceNames = new SubShapeMap<string>()
  toolFaceNames.set(above.base, capName(featureId, 'above'))
  toolFaceNames.set(below.base, capName(featureId, 'below'))
  const produced = transferFor(
    oc, scope, names, compound,
    [...above.faceOrigin, ...below.faceOrigin],
    toolFaceNames,
  )
  // The above half keeps the body id: it is the material on the normal side,
  // which is what the id meant before the split.
  const preferred = exploreSolids(oc, scope, above.shape)[0] ?? null
  const ids = resplitBody(oc, scope, table, bodyStore, body, compound, featureId, produced, preferred)
  body.brep_diff = above.diff
  return ids
}
