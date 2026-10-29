// The explicit boolean leaf (union / subtract / intersect of whole bodies, vs the implicit
// cut/add an extrude does). It resolves a target body and a list of tool bodies, folds each
// tool into the target via booleanWithDiff, removes consumed tools, and splits any
// disconnected result solids into extra bodies.
//
// The split used to be limited to `subtract`, on the assumption that only a cut can
// disconnect a body. It cannot: a union of two bodies that do not touch is a two-solid
// compound, and an intersect can leave several lumps just as a cut can. Every operation now
// goes through `resplitBody`.
//
// Construction names are folded through the tool loop the same way bodyOps' cut/add and the
// array fuse do: each `booleanWithDiff` hands back a faceOrigin map, and `transferBooleanNames`
// carries the accumulated names onto the new shape by subshape identity. Skipping that (which
// this leaf used to do, keeping names keyed by the target's pre-boolean faces) silently unnamed every
// face the boolean reshaped, and every edge around them with it. Only the LAST tool's brep_diff
// is retained.

import { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { booleanWithDiff, volumeOf, shapesIntersect, BooleanSoundnessError } from '../occ/booleans'
import { offsetSolid, OffsetError } from '../occ/offsetShape'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { resplitBody } from './bodySplit'
import { transferBooleanNames } from './booleanLineage'
import { readBodyNames } from '../occ/bodyNames'
import { stripRefSigil } from '@/utils/refSigil'
import { nestedFeatureParams } from './shared/featureParams'

type Dict = Record<string, unknown>

interface BooleanResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
}

const OP_MAP: Record<string, 'fuse' | 'cut' | 'common'> = {
  union: 'fuse',
  subtract: 'cut',
  intersect: 'common',
}

/**
 * The one clearance failure message: the offset could not be applied to a tool.
 * Every clearance failure (the offset itself, a shrunk tool that no longer
 * reaches the target, an unsound cut) goes through here so the feature names
 * the clearance rather than falling back to an ungrown cut or the generic
 * tangency nudge (decision 6).
 */
function clearanceFailure(clearance: number, toolRef: string, reason: string): Error {
  return new Error(
    `boolean: clearance ${clearance} could not be applied to tool '${toolRef}': ${reason}. ` +
    "Reduce the clearance; a negative clearance cannot exceed the tool's smallest fillet radius or wall half-thickness.",
  )
}

/**
 * Grow (c > 0) or shrink (c < 0) a tool with a sharp-join 3D offset, translating
 * the offset's own failure into a clearance-specific message. The feature never
 * falls back to an ungrown cut: a hole that is silently the wrong size is worse
 * than an error (decision 6).
 */
function growTool(
  oc: OccModule,
  scope: DisposeScope,
  toolShape: OccShape,
  clearance: number,
  toolRef: string,
): { shape: OccShape; faceImage: (src: OccSubShape) => OccSubShape } {
  try {
    return offsetSolid(oc, scope, toolShape, clearance)
  } catch (e) {
    if (e instanceof OffsetError) throw clearanceFailure(clearance, toolRef, e.message)
    throw e
  }
}

const ARRAY_KINDS = new Set(['array', 'circular_array'])

/**
 * Every live body one array feature stands for: its source body (instance 0
 * under `operation: new`, the fused body under `add`), every body the array
 * minted, and every body the array's OWN disjoint split produced, in store
 * order. Resolved against the store at boolean time, so a later count change is
 * followed without editing the boolean.
 *
 * The split siblings are the `add` case: `resplitBody` hands them the SOURCE
 * body's `created_by` (the spoke's extrude, not the array), so `created_by`
 * alone missed them and the boolean fused only the source instance (car-wheel
 * F4). `split_from` records the feature whose split minted the sibling, and it
 * is not inherited: a body a LATER feature split off (a nested array, a union
 * of disjoint material folded into a copy) belongs to that feature, not this
 * array. `modified_by` is deliberately NOT consulted either: it would catch
 * both of those over-attributions.
 */
function arrayMemberIds(arrayId: string, def: Dict, bodyStore: Record<string, Body>): string[] {
  // The builder folds legacy flat params only into the feature being solved, so
  // an upstream array's source is read through the same canonicalizer.
  const sub = (nestedFeatureParams(def).feature[def.kind as string] as Dict | undefined) ?? {}
  const ids: string[] = []
  const source = sub.source_body
  if (typeof source === 'string' && source !== '') {
    try {
      ids.push(resolveBody(source, bodyStore).id)
    } catch {
      // A source that no longer resolves leaves only the minted copies.
    }
  }
  for (const [bid, body] of Object.entries(bodyStore)) {
    if (body.created_by === arrayId || body.split_from?.feature === arrayId) {
      if (!ids.includes(bid)) ids.push(bid)
    }
  }
  return ids
}

/**
 * The tool list with every array-feature ref (`@<arrayId>` or the bare id)
 * expanded to that array's member bodies. Typing forty instance ids by hand
 * was error-prone (sprocket F3), and a hand list froze at the count it was
 * typed for (din_rail F1: raising the count left the new slots floating free).
 * The target is dropped from an expansion, so `target: <source>, tools:
 * [@ar1]` unions or subtracts the copies without naming the source as its own
 * tool. Returns the expanded refs and the array ids that were named.
 */
function expandArrayTools(
  toolRefs: string[],
  targetId: string,
  featuresById: Record<string, Dict>,
  bodyStore: Record<string, Body>,
): { refs: string[]; namedArrays: Set<string> } {
  const refs: string[] = []
  const namedArrays = new Set<string>()
  for (const ref of toolRefs) {
    const key = stripRefSigil(ref, '@')
    const def = featuresById[key]
    // A body id wins over a feature id of the same spelling.
    if (def !== undefined && ARRAY_KINDS.has(def.kind as string) && !(key in bodyStore)) {
      // featuresById holds only the features solved so far, so an array defined
      // after this boolean never reaches here: its ref stays unresolved below
      // and the tool loop refuses it by name instead of consuming its source.
      namedArrays.add(key)
      refs.push(...arrayMemberIds(key, def, bodyStore).filter((id) => id !== targetId))
    } else {
      refs.push(ref)
    }
  }
  // An array listed twice, or beside its own instance ids, folds each body once.
  return { refs: [...new Set(refs)], namedArrays }
}

/**
 * A hand-typed tool list that names some but not all of one array's bodies,
 * the din_rail F1 trap: the warning names the counts and the array ref that
 * follows the count instead.
 */
function partialArrayWarnings(
  toolIds: Set<string>,
  targetId: string,
  namedArrays: Set<string>,
  featuresById: Record<string, Dict>,
  bodyStore: Record<string, Body>,
): string[] {
  const warnings: string[] = []
  for (const [fid, def] of Object.entries(featuresById)) {
    if (!ARRAY_KINDS.has(def.kind as string) || namedArrays.has(fid)) continue
    const members = arrayMemberIds(fid, def, bodyStore).filter((id) => id !== targetId)
    const used = members.filter((id) => toolIds.has(id)).length
    if (used > 0 && used < members.length) {
      warnings.push(
        `array ${fid} has ${members.length} instances, the boolean uses ${used}; ` +
          `name '@${fid}' in tools to take every instance`,
      )
    }
  }
  return warnings
}

/** Solve a boolean feature into the body store (mirrors `_solve_boolean`). */
export function solveBoolean(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict> = {},
): BooleanResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.boolean as Dict) ?? {}
  const operation = (sub.operation as string) ?? 'union'
  const targetRef = (sub.target as string) ?? ''
  const authoredTools = (sub.tools as string[]) ?? []
  const keepTools = (sub.keep_tools as boolean) ?? false
  // Signed mm: grows (+) or shrinks (-) every tool of a subtract, isotropically.
  // Absent means 0; a non-zero value on union/intersect is ignored with a
  // warning so switching the operation never breaks a doc (decision 5). The
  // solve pipeline resolves `clearance` expressions first, so anything present
  // that is not a number here is malformed and must fail by name rather than
  // silently become an ungrown cut (decision 6).
  const rawClearance = sub.clearance
  if (rawClearance !== undefined && typeof rawClearance !== 'number') {
    throw new Error(`boolean: 'clearance' must be a number, got ${typeof rawClearance}`)
  }
  const clearance = typeof rawClearance === 'number' ? rawClearance : 0

  if (!targetRef) throw new Error("boolean: 'target' is required")
  if (authoredTools.length === 0) throw new Error("boolean: 'tools' must have at least one entry")

  const op = OP_MAP[operation]
  if (op === undefined) throw new Error(`boolean: unknown operation '${operation}'`)

  const targetBody = resolveBody(targetRef, bodyStore)
  if (targetBody.shape === null) throw new Error(`boolean: target '${targetRef}' has no shape`)
  const { refs: toolRefs, namedArrays } = expandArrayTools(authoredTools, targetBody.id, featuresById, bodyStore)
  if (toolRefs.length === 0) {
    throw new Error(`boolean: the array tool(s) ${[...namedArrays].join(', ')} have no body besides the target`)
  }

  let resultShape: OccShape = table.get<OccShape>(targetBody.shape)
  const consumedKeys: string[] = []
  let lastDiff: BrepDiff | null = null
  let foldedAny = false
  // Folded across the tools: each step's output names are the next step's target
  // names, so a face keeps its identity through a multi-tool boolean.
  let { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry } = readBodyNames(oc, scope, resultShape, targetBody)
  const result: BooleanResult = { status: 'ok', body_id: targetBody.id, body_ids: [], operation }
  const warn = (msg: string): void => {
    result.solver_warning = result.solver_warning === undefined ? msg : `${result.solver_warning}; ${msg}`
  }
  if (op !== 'cut' && clearance !== 0) warn('clearance applies to subtract only; ignored')
  // Resolved before any tool is consumed: the store still holds every member.
  const explicitToolIds = new Set<string>()
  for (const ref of toolRefs) {
    try {
      explicitToolIds.add(resolveBody(ref, bodyStore).id)
    } catch {
      // The tool loop below reports a bad ref by name.
    }
  }
  for (const w of partialArrayWarnings(explicitToolIds, targetBody.id, namedArrays, featuresById, bodyStore)) warn(w)

  for (const toolRef of toolRefs) {
    const toolBody = resolveBody(toolRef, bodyStore)
    if (toolBody.shape === null) throw new Error(`boolean: tool '${toolRef}' has no shape`)
    if (toolBody.id === targetBody.id) {
      // The target and the tool resolved to the same body. A union/common is a
      // no-op with a real cost, a cut eats the whole target, and the tool
      // cleanup below would release the target's handle and then resplitBody
      // would release it again. Refuse before any OCC work, even with
      // keep_tools: target-as-tool is a spec error regardless.
      throw new Error(
        `boolean: tool '${toolRef}' resolves to the target body '${targetBody.id}'; ` +
        'a body cannot be its own tool',
      )
    }
    const toolShape = table.get<OccShape>(toolBody.shape)
    const unifyFaces = !(targetBody.imported || toolBody.imported)

    // A subtract grows each tool before the cut (clearance > 0) or shrinks it
    // (clearance < 0). The grown shape is a transient operand of this step: the
    // tool body, the consumed-tool release, keep_tools and the resplit all keep
    // seeing the authored tool. Grown faces carry their source face's UUID, so a
    // pick on a hole wall keeps its identity across a clearance edit.
    const toolNames = readBodyNames(oc, scope, toolShape, toolBody)
    let cutTool = toolShape
    if (op === 'cut' && clearance !== 0) {
      const grown = growTool(oc, scope, toolShape, clearance, toolRef)
      cutTool = scope.track(grown.shape)
      const rekeyed = new SubShapeMap<string>()
      for (const [face, uuid] of toolNames.faceNames.entries()) {
        rekeyed.set(grown.faceImage(face), uuid)
      }
      toolNames.faceNames = rekeyed
    }

    // Mirror the implicit cut/add guards (bodyOps.applyBodyOperation): probe the
    // overlap before folding so a disjoint tool is neither consumed nor left
    // silent. A subtract of a non-overlapping tool would otherwise eat the body
    // with no visible effect; an intersect of disjoint bodies yields an empty
    // compound that must not be reported as 'ok'. The probe is a bare Common
    // with history off (M18); the fuse path never probed and must not start. A
    // grown tool is probed grown: a tool flush against the target intersects
    // only once it has grown, which is the intended behaviour.
    if (op === 'cut' || op === 'common') {
      if (!shapesIntersect(oc, resultShape, cutTool)) {
        // A shrunk tool (clearance < 0) is a subset of the authored one: if it
        // no longer reaches the target, the offset degenerated into a shape the
        // kernel cannot cut (or the authored tool never touched). Report the
        // clearance rather than skipping: a missing hole shown as 'ok' is worse
        // than an error (decision 6).
        if (op === 'cut' && clearance < 0) {
          throw clearanceFailure(clearance, toolRef, 'the shrunk tool does not intersect the target')
        }
        warn(`${operation}: tool '${toolRef}' does not intersect the target; skipped`)
        continue
      }
    }

    const prevShape = resultShape
    let res
    try {
      res = booleanWithDiff(oc, scope, resultShape, cutTool, op, { unifyFaces })
    } catch (e) {
      // A clearance growth can push the cut into a tangency the kernel cannot
      // resolve; name the clearance rather than the generic nudge message.
      if (op === 'cut' && clearance !== 0 && e instanceof BooleanSoundnessError) {
        throw clearanceFailure(clearance, toolRef, e.message)
      }
      throw e
    }
    resultShape = scope.track(res.shape)
    if (foldedAny) scope.release(prevShape)
    const names = transferBooleanNames(oc, scope, {
      bodyShape: resultShape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: faceNames,
      targetFaceAncestry: faceAncestry,
      targetCapAncestry: capAncestry,
      toolFaceNames: toolNames.faceNames,
      toolFaceAncestry: toolBody.face_ancestry ?? null,
      toolCapAncestry: toolBody.face_cap_ancestry ?? null,
      toolUuidScope: keepTools ? featureId : null,
    })
    ;({ faceNames, faceAncestry, edgeNames, edgeAncestry, capAncestry } = names)
    lastDiff = res.diff
    foldedAny = true
    if (!keepTools) consumedKeys.push(toolBody.id)
  }

  targetBody.modified_by.push(featureId)
  targetBody.brep_diff = lastDiff

  // Mirror the implicit cut/add warning: a boolean that consumed a tool but left
  // the target's brep_diff untouched produced no real geometry change.
  if (foldedAny && lastDiff !== null && brepDiffIsEmpty(lastDiff)) {
    warn(`${operation}: operation produced no geometry change`)
  }

  // An intersect of disjoint bodies yields an empty compound; name it so the
  // empty result is not silently reported as a successful boolean.
  if (op === 'common' && foldedAny && result.solver_warning === undefined) {
    const probe = new DisposeScope()
    try {
      if (volumeOf(oc, probe, resultShape) < 1e-10) {
        warn(`${operation}: operation produced no overlapping geometry (empty result)`)
      }
    } catch {
      // Volume probe failed; leave without the warning.
    } finally {
      probe.dispose()
    }
  }

  // Drop consumed tool bodies (release their handles first). Dedup so a tool
  // listed twice is not double-released. This has to happen BEFORE the resplit,
  // which hands the target the tools' face UUIDs: the build loop evicts a
  // consumed tool's registrations by watching it leave the store, so a tool
  // still there once the target holds its UUIDs would leave one UUID naming two
  // live faces with nothing left to notice. Nothing between here and the
  // resplit reads a tool.
  for (const key of new Set(consumedKeys)) {
    const tool = bodyStore[key]
    if (tool !== undefined) {
      if (tool.shape !== null) {
        // The consumed tool's shape was minted by its own producer (last
        // modifier, else creator); settle that exact claim so its eviction-time
        // `releaseOwner` cannot over-decrement (see releaseFor).
        table.releaseFor(tool.shape, tool.modified_by.at(-1) ?? tool.created_by)
      }
      delete bodyStore[key]
    }
  }

  const bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, resultShape, featureId, {
    faceNames, edgeNames, faceAncestry, edgeAncestry,
  })

  if (bodyIds.length === 0) {
    // The operation ate the whole target (a subtract whose tool swallows it).
    // resplitBody deleted the body from the store; report the deletion with
    // body_id still naming the consumed body and body_ids: [] for "nothing
    // survives" (the convention stated in resplitBody's docstring).
    warn(`boolean: the ${operation} removed all of body '${targetBody.id}'; the body was deleted`)
    result.body_ids = []
    return result
  }

  result.body_ids = bodyIds
  return result
}
