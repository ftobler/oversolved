// The explicit boolean leaf (union / subtract / intersect of whole bodies, vs the implicit
// cut/add an extrude does). It resolves a base body and a list of tool bodies, folds each
// tool into the base via booleanWithDiff, removes consumed tools, and splits any
// disconnected result solids into extra bodies.
//
// A union or an intersect has no target/tools split: the first pick is only the base that
// keeps the body's id and name. Its tools are folded in connectivity order from the base
// (fuse whatever touches the growing result, repeat), so the geometry does not depend on
// the order the picks were listed in; a pick whose component never reaches the base is
// skipped with the cut's own warning. A subtract keeps its target/tool roles and its list
// order.
//
// The split used to be limited to `subtract`, on the assumption that only a cut can
// disconnect a body. It cannot: an intersect can leave several lumps, and a union whose
// tools meet the shape only at a point or an edge comes back as a multi-solid compound.
// Every operation now goes through `resplitBody`. A union pick that does not touch the
// base at all is skipped instead, so disjoint material never reaches the split.
//
// Construction names are folded through the tool loop the same way partOps' cut/add and the
// array fuse do: each `booleanWithDiff` hands back a faceOrigin map, and `transferBooleanNames`
// carries the accumulated names onto the new shape by subshape identity. Skipping that (which
// this leaf used to do, keeping names keyed by the target's pre-boolean faces) silently unnamed every
// face the boolean reshaped, and every edge around them with it. Only the LAST tool's brep_diff
// is retained.

import { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolvePart } from './shared/partResolution'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { booleanWithDiff, volumeOf, shapesIntersect, shapesTouch, BooleanSoundnessError } from '../occ/booleans'
import { maxPrecision, precisionCeilingWarning, type KernelPrecision } from '../precision'
import { nearCoaxialCylinderWarning, shapeHasCoaxialCylinder } from '../occ/nearCoaxial'
import { helixAxisOfSweepDef } from './shared/helixPath'
import { offsetSolid, OffsetError } from '../occ/offsetShape'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { resplitPart } from './partSplit'
import { transferBooleanNames } from './booleanLineage'
import { readPartNames } from '../occ/partNames'
import { stripRefSigil } from '@/utils/refSigil'
import { patternSubject } from '@/utils/core/patternSubject'
import { isPatternKind } from '@/types/cad'
import { nestedFeatureParams } from './shared/featureParams'
import { swallowUnlessTrap } from '../errors'

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

/** A body-subject pattern owns the bodies its copies minted. A feature-subject
 *  pattern reshapes one existing body, so a boolean ref to it is ordinary
 *  feature behavior, not a body-list expansion. Every pattern kind is decided
 *  through PATTERN_KINDS, so a later kind joins the expansion by joining the
 *  list. */
function isPartPattern(def: Dict): boolean {
  const kind = def.kind
  if (typeof kind !== 'string' || !isPatternKind(kind)) return false
  const sub = (nestedFeatureParams(def).feature[kind] as Dict | undefined) ?? {}
  return patternSubject(sub) === 'body'
}

/**
 * Every live body one body-pattern feature stands for: its source body
 * (instance 0 under `operation: new`, the fused body under `add`), every body
 * the pattern minted, and every body the pattern's OWN disjoint split produced,
 * in store order. Resolved against the store at boolean time, so a later count
 * change is followed without editing the boolean.
 *
 * The split siblings are the `add` case: `resplitBody` hands them the SOURCE
 * body's `created_by` (the spoke's extrude, not the pattern), so `created_by`
 * alone missed them and the boolean fused only the source instance (car-wheel
 * F4). `split_from` records the feature whose split minted the sibling, and it
 * is not inherited: a body a LATER feature split off (a nested pattern, a union
 * of disjoint material folded into a copy) belongs to that feature, not this
 * pattern. `modified_by` is deliberately NOT consulted either: it would catch
 * both of those over-attributions.
 */
function patternMemberIds(patternId: string, def: Dict, partStore: Record<string, PartSolid>): string[] {
  // The builder folds legacy flat params only into the feature being solved, so
  // an upstream pattern's source is read through the same canonicalizer.
  const sub = (nestedFeatureParams(def).feature[def.kind as string] as Dict | undefined) ?? {}
  const ids: string[] = []
  const source = sub.source_body
  if (typeof source === 'string' && source !== '') {
    try {
      ids.push(resolvePart(source, partStore).id)
    } catch (e) {
      swallowUnlessTrap(e)
      // A source that no longer resolves leaves only the minted copies.
    }
  }
  for (const [bid, body] of Object.entries(partStore)) {
    if (body.created_by === patternId || body.split_from?.feature === patternId) {
      if (!ids.includes(bid)) ids.push(bid)
    }
  }
  return ids
}

/**
 * The tool list with every body-pattern ref (`@<patternId>` or the bare id)
 * expanded to that pattern's member bodies. Typing forty instance ids by hand
 * was error-prone (sprocket F3), and a hand list froze at the count it was
 * typed for (din_rail F1: raising the count left the new slots floating free).
 * The target is dropped from an expansion, so `target: <source>, tools:
 * [@ar1]` unions or subtracts the copies without naming the source as its own
 * tool. Returns the expanded refs and the pattern ids that were named.
 */
function expandPatternTools(
  toolRefs: string[],
  targetId: string,
  featureId: string,
  featuresById: Record<string, Dict>,
  partStore: Record<string, PartSolid>,
): { refs: string[]; namedPatterns: Set<string> } {
  const refs: string[] = []
  const namedPatterns = new Set<string>()
  const order = Object.keys(featuresById)
  // A solver unit test may pass only the referenced features, with the
  // boolean's own id absent; then nothing can be proven downstream and every
  // present pattern counts as upstream, the historical behaviour.
  const selfIndex = order.indexOf(featureId)
  for (const ref of toolRefs) {
    const key = stripRefSigil(ref, '@')
    const def = featuresById[key]
    // A body id wins over a feature id of the same spelling. A pattern defined
    // after this feature has not solved yet; expanding it would read its source
    // body and consume it before its own feature ran (the whole-document solve
    // sees every feature, unlike a per-step one). Leave the ref unresolved so
    // the tool loop refuses it by name.
    const upstream = key !== featureId && (selfIndex < 0 || order.indexOf(key) < selfIndex)
    if (def !== undefined && isPartPattern(def) && upstream && !(key in partStore)) {
      namedPatterns.add(key)
      refs.push(...patternMemberIds(key, def, partStore).filter((id) => id !== targetId))
    } else {
      refs.push(ref)
    }
  }
  // A pattern listed twice, or beside its own instance ids, folds each body once.
  return { refs: [...new Set(refs)], namedPatterns }
}

/**
 * A hand-typed tool list that names some but not all of one pattern's bodies,
 * the din_rail F1 trap: the warning names the counts and the pattern ref that
 * follows the count instead.
 */
function partialPatternWarnings(
  toolIds: Set<string>,
  targetId: string,
  featureId: string,
  namedPatterns: Set<string>,
  featuresById: Record<string, Dict>,
  partStore: Record<string, PartSolid>,
): string[] {
  const warnings: string[] = []
  const order = Object.keys(featuresById)
  const selfIndex = order.indexOf(featureId)
  for (const [fid, def] of Object.entries(featuresById)) {
    const upstream = fid !== featureId && (selfIndex < 0 || order.indexOf(fid) < selfIndex)
    if (!isPartPattern(def) || !upstream || namedPatterns.has(fid)) continue
    const members = patternMemberIds(fid, def, partStore).filter((id) => id !== targetId)
    const used = members.filter((id) => toolIds.has(id)).length
    if (used > 0 && used < members.length) {
      warnings.push(
        `pattern ${fid} has ${members.length} instances, the boolean uses ${used}; ` +
          `name '@${fid}' in tools to take every instance`,
      )
    }
  }
  return warnings
}

/** One resolved tool pick: the authored ref (for a warning) and the body it names. */
interface ToolEntry {
  ref: string
  part: PartSolid
}

/**
 * The connectivity order a symmetric operation folds its tools in, and the ones
 * that connect to nothing the base can reach.
 *
 * Union and intersect have no target/tools split, so the authored list order may
 * not decide the geometry: a chain A-B-C picked as base A with tools [C, B] used
 * to fold C first, find it apart from A, and (for a cut) skip it, while [B, C]
 * joined all three. The connection graph is walked from the base instead, so the
 * same set of picks folds the same way whichever order it was picked in.
 *
 * Candidates are visited in the body store's own order (not the authored order),
 * which makes the fold, and with it the target-wins face naming, independent of
 * the picks too. A union connects through touching faces (a shared face fuses
 * material); an intersect only through shared material, the overlap its own
 * skip probe reads.
 *
 * Every pair is probed at most once, so the cost is one connectivity probe per
 * candidate pair per solve, never the boolean itself.
 */
function orderSymmetricTools(
  oc: OccModule,
  table: HandleTable,
  op: 'fuse' | 'common',
  baseShape: OccShape,
  tools: ToolEntry[],
  partStore: Record<string, PartSolid>,
): { ordered: ToolEntry[]; disconnected: ToolEntry[] } {
  const storeIndex = new Map(Object.keys(partStore).map((id, i) => [id, i]))
  const storePosition = (part: PartSolid): number => storeIndex.get(part.id) ?? Number.MAX_SAFE_INTEGER
  // The candidates are deduped by resolved body id above, and every one is a
  // live store entry, so the positions are distinct and this is a total order.
  const sorted = [...tools].sort((a, b) => storePosition(a.part) - storePosition(b.part))
  const connects = op === 'fuse' ? shapesTouch : shapesIntersect
  const frontier: OccShape[] = [baseShape]
  const accepted: ToolEntry[] = []
  const acceptedIds = new Set<string>()
  // How much of the frontier a candidate has already been probed against, so a
  // later pass only tests the shapes that joined since.
  const probedTo = new Map<string, number>()
  let grew = true
  while (grew) {
    grew = false
    for (const tool of sorted) {
      if (acceptedIds.has(tool.part.id)) continue
      const shape = table.get<OccShape>(tool.part.shape!)
      let at = probedTo.get(tool.part.id) ?? 0
      let hit = false
      for (; at < frontier.length; at++) {
        if (connects(oc, frontier[at], shape)) { hit = true; break }
      }
      if (!hit) {
        probedTo.set(tool.part.id, frontier.length)
        continue
      }
      accepted.push(tool)
      acceptedIds.add(tool.part.id)
      frontier.push(shape)
      grew = true
    }
  }
  return { ordered: accepted, disconnected: sorted.filter((tool) => !acceptedIds.has(tool.part.id)) }
}

/** Solve a boolean feature into the body store (mirrors `_solve_boolean`). */
export function solveBoolean(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
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

  const targetPart = resolvePart(targetRef, partStore)
  if (targetPart.shape === null) throw new Error(`boolean: target '${targetRef}' has no shape`)
  const { refs: toolRefs, namedPatterns } = expandPatternTools(authoredTools, targetPart.id, featureId, featuresById, partStore)
  if (toolRefs.length === 0) {
    throw new Error(`boolean: the pattern tool(s) ${[...namedPatterns].join(', ')} have no part besides the target`)
  }

  let resultShape: OccShape = table.get<OccShape>(targetPart.shape)
  const consumedKeys: string[] = []
  let lastDiff: BrepDiff | null = null
  let foldedAny = false
  // Folded across the tools: each step's output names are the next step's target
  // names, so a face keeps its identity through a multi-tool boolean.
  let { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry, faceOwner, edgeOwner } =
    readPartNames(oc, scope, resultShape, targetPart)
  const result: BooleanResult = { status: 'ok', body_id: targetPart.id, body_ids: [], operation }
  // The merge widens by the max reported precision over the target and every
  // tool that actually contributes, up to the ceiling (kernel/precision.ts).
  let precision: KernelPrecision | null = targetPart.precision ?? null
  const warn = (msg: string): void => {
    result.solver_warning = result.solver_warning === undefined ? msg : `${result.solver_warning}; ${msg}`
  }
  if (op !== 'cut' && clearance !== 0) warn('clearance applies to subtract only; ignored')
  // Resolved before any tool is consumed: the store still holds every member.
  const explicitToolIds = new Set<string>()
  for (const ref of toolRefs) {
    try {
      explicitToolIds.add(resolvePart(ref, partStore).id)
    } catch (e) {
      swallowUnlessTrap(e)
      // The tool loop below reports a bad ref by name.
    }
  }
  for (const w of partialPatternWarnings(explicitToolIds, targetPart.id, featureId, namedPatterns, featuresById, partStore)) warn(w)

  // Resolve every tool before any OCC work: a bad ref or a self-pick should
  // fail by name without first folding half the list. A symmetric operation
  // treats its picks as a set, so a body listed twice is one tool.
  const symmetric = op === 'fuse' || op === 'common'
  const toolEntries: ToolEntry[] = []
  for (const toolRef of toolRefs) {
    const toolPart = resolvePart(toolRef, partStore)
    if (toolPart.shape === null) throw new Error(`boolean: tool '${toolRef}' has no shape`)
    if (toolPart.id === targetPart.id) {
      // The target and the tool resolved to the same body. A union/common is a
      // no-op with a real cost, a cut eats the whole target, and the tool
      // cleanup below would release the target's handle and then resplitBody
      // would release it again. Refuse before any OCC work, even with
      // keep_tools: target-as-tool is a spec error regardless.
      throw new Error(
        `boolean: tool '${toolRef}' resolves to the target part '${targetPart.id}'; ` +
        'a part cannot be its own tool',
      )
    }
    if (symmetric && toolEntries.some((entry) => entry.part.id === toolPart.id)) continue
    toolEntries.push({ ref: toolRef, part: toolPart })
  }

  // The base anchors the fold. A union/intersect folds the base's connected
  // component in store order and skips the picks that never reach it; a subtract
  // keeps the authored tool order.
  let foldEntries = toolEntries
  if (symmetric) {
    const { ordered, disconnected } = orderSymmetricTools(
      oc, table, op, resultShape, toolEntries, partStore,
    )
    for (const tool of disconnected) {
      warn(`${operation}: tool '${tool.ref}' does not intersect the target; skipped`)
    }
    foldEntries = ordered
  }

  for (const { ref: toolRef, part: toolBody } of foldEntries) {
    const toolShape = table.get<OccShape>(toolBody.shape!)
    // A helical band meeting the wall of its coaxial cylinder makes the clean's
    // face merge (ShapeUpgrade_UnifySameDomain with unifyFaces) spin forever;
    // the edge merge is safe, so only the face merge is skipped for that
    // geometry. `created_by` names the sweep, and the repo descriptor its path
    // registered is the same curve the sweep built.
    const targetAxis = helixAxisOfSweepDef(featuresById[targetPart.created_by], globalRepo)
    const toolAxis = helixAxisOfSweepDef(featuresById[toolBody.created_by], globalRepo)
    const coaxialHelix = (targetAxis !== null && shapeHasCoaxialCylinder(oc, scope, toolShape, targetAxis))
      || (toolAxis !== null && shapeHasCoaxialCylinder(oc, scope, resultShape, toolAxis))
    const unifyFaces = !(targetPart.imported || toolBody.imported) && !coaxialHelix

    // A subtract grows each tool before the cut (clearance > 0) or shrinks it
    // (clearance < 0). The grown shape is a transient operand of this step: the
    // tool body, the consumed-tool release, keep_tools and the resplit all keep
    // seeing the authored tool. Grown faces carry their source face's UUID, so a
    // pick on a hole wall keeps its identity across a clearance edit.
    const toolNames = readPartNames(oc, scope, toolShape, toolBody)
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

    // Mirror the implicit cut/add guards (partOps.applyPartOperation): probe the
    // overlap before folding so a disjoint tool is neither consumed nor left
    // silent. A subtract of a non-overlapping tool would otherwise eat the body
    // with no visible effect; an intersect of disjoint bodies yields an empty
    // compound that must not be reported as 'ok'. The probe is a bare Common
    // with history off (M18). A union's membership was already settled by the
    // connectivity walk (`orderSymmetricTools`) before the fold, so it is never
    // probed a second time here. An intersect keeps this
    // probe because an intermediate result can shrink away from a tool that
    // overlapped the base. A grown tool is probed grown: a tool flush against
    // the target intersects only once it has grown, which is the intended
    // behaviour.
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

    // Only a tool that reaches the target contributes to the merge, and with it
    // its own reported precision.
    precision = maxPrecision(precision, toolBody.precision)
    const prevShape = resultShape
    let res
    try {
      res = booleanWithDiff(oc, scope, resultShape, cutTool, op, { unifyFaces, precision })
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
      partShape: resultShape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: faceNames,
      targetFaceAncestry: faceAncestry,
      targetCapAncestry: capAncestry,
      targetFaceOwner: faceOwner,
      targetEdgeOwner: edgeOwner,
      toolFaceNames: toolNames.faceNames,
      toolFaceAncestry: toolBody.face_ancestry ?? null,
      toolCapAncestry: toolBody.face_cap_ancestry ?? null,
      toolFaceOwner: toolNames.faceOwner,
      toolEdgeOwner: toolNames.edgeOwner,
      toolCreatedBy: toolBody.created_by,
      toolUuidScope: keepTools ? featureId : null,
    })
    ;({ faceNames, faceAncestry, edgeNames, edgeAncestry, capAncestry, faceOwner, edgeOwner } = names)
    lastDiff = res.diff
    foldedAny = true
    if (!keepTools) consumedKeys.push(toolBody.id)
  }

  targetPart.modified_by.push(featureId)
  targetPart.brep_diff = lastDiff

  // A union can keep two near-coaxial cylinder faces with a microscopic
  // shoulder; name it before a later fillet at the junction refuses opaquely.
  if (op === 'fuse' && foldedAny) {
    const nearCoaxial = nearCoaxialCylinderWarning(oc, scope, resultShape)
    if (nearCoaxial !== null) warn(nearCoaxial)
  }

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
    } catch (e) {
      swallowUnlessTrap(e)
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
    const tool = partStore[key]
    if (tool !== undefined) {
      if (tool.shape !== null) {
        // The consumed tool's shape was minted by its own producer (last
        // modifier, else creator); settle that exact claim so its eviction-time
        // `releaseOwner` cannot over-decrement (see releaseFor).
        table.releaseFor(tool.shape, tool.modified_by.at(-1) ?? tool.created_by)
      }
      delete partStore[key]
    }
  }

  const partIds = resplitPart(oc, scope, table, partStore, targetPart, resultShape, featureId, {
    faceNames, edgeNames, faceAncestry, edgeAncestry, faceOwner, edgeOwner,
  }, null, precision)

  const ceiling = foldedAny && precision !== null ? precisionCeilingWarning(precision) : null
  if (ceiling !== null) warn(ceiling)

  if (partIds.length === 0) {
    // The operation ate the whole target (a subtract whose tool swallows it).
    // resplitBody deleted the body from the store; report the deletion with
    // body_id still naming the consumed body and body_ids: [] for "nothing
    // survives" (the convention stated in resplitBody's docstring).
    warn(`boolean: the ${operation} removed all of part '${targetPart.id}'; the part was deleted`)
    result.body_ids = []
    return result
  }

  result.body_ids = partIds
  return result
}
