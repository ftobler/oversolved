// The feature subject of a pattern: repeat one or more earlier solid-producing
// features' own add or cut inside the body each feature already shaped. This is
// the half pattern.ts delegates to; the body subject lives in patternBody.ts and
// both share the copies the pattern kind built. The sub-def arrives as a
// parameter, so every pattern kind reuses this leaf without teaching it a new
// sub-dict key, and the mirror's feature subject calls it with one reflect
// transform (options.noun/opName say "mirror" in the messages).
//
// Each source's tool is obtained by re-solving the source with its operation
// forced to `new` into a throwaway body store. Those scratch bodies are released
// at the end of this solve; they never enter the real store, so no part row or
// checkpoint sees them.
//
// Several sources are a union: every source's tool is applied at every grid
// instance, in the order the sources sit in the feature log (then each source's
// own output order). The first source's first produced body is the instance-0
// seed, because the grid always leaves the seed slot to the sources. A source
// that no longer exists or now sits after the pattern is dropped with a named
// warning on the result; a pattern left with no source is refused by name.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousPartRefError, resolvePart } from './shared/partResolution'
import { applyPartOperation } from './partOps'
import {
  readSourceFaceRows, rebuildNamesForTransformedCopy, transformCopyWithMapping, type NameMaps,
} from '../occ/transformLineage'
import { emptyShapeNames, mergeShapeNames, readPartNames } from '../occ/partNames'
import { booleanWithDiffMany, countSolids, shapesIntersect, toolsThatShaped } from '../occ/booleans'
import { transferBooleanNames } from './booleanLineage'
import { resplitPart, solidHoldingFaces } from './partSplit'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { markFeatureStart, markFeatureProgress } from '../featureProgress'
import { resolveFeatureExpressions } from '../featureExpressions'
import { solveExtrude } from './extrude'
import { solveRevolve } from './revolve'
import { solveSweep } from './sweep'
import { solveWrap } from './wrap'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import { stripRefSigil } from '@/utils/refSigil'
import { solidCentroid, type Vec3 } from '../occ/primitives'
import type { Dict, PatternCopy } from './pattern'

export interface PatternResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  operation?: string
  solver_warning?: string
  exception?: string
}

/**
 * How the caller names this copy run in its refusals. A pattern repeats copies,
 * a mirror reflects one, so both read the same engine with their own word. The
 * coincidence predicate is the mirror's alone: only the leaf knows which
 * transform it built, and a copy that lands on its own source changes nothing
 * (the boolean would otherwise report it as an ordinary miss).
 */
export interface FeatureCopiesOptions {
  noun?: string
  opName?: string
  coincides?: (tool: OccShape, copy: OccShape) => boolean
}

/** The kinds whose leaf builds a tool and routes it through applyBodyOperation
 *  with add/cut/new, so `operation: new` hands the same tool back as a body. */
const TOOL_LEAVES = {
  extrude: solveExtrude,
  revolve: solveRevolve,
  sweep: solveSweep,
  wrap: solveWrap,
} as const

type ToolKind = keyof typeof TOOL_LEAVES

function isToolKind(kind: string): kind is ToolKind {
  return Object.hasOwn(TOOL_LEAVES, kind)
}

/** What a source has to be, in the caller's own words. The pattern's sentence
 *  predates the shared engine and is pinned by its tests, so it stays literal;
 *  a mirror reads the same rule with its own name. */
function sourceKindSentence(noun: string): string {
  return noun === 'pattern'
    ? 'a feature pattern repeats an extrude, revolve, sweep or wrap'
    : `a ${noun} source repeats an extrude, revolve, sweep or wrap`
}

/** The sources a feature pattern names, in the authored order. A row written
 *  before the multi-source field carries the singular scalar; reading both here
 *  keeps a document that skipped the loader's ladder solvable. */
function sourceFeatureRefs(sub: Dict): string[] {
  const list = sub.source_features
  if (Array.isArray(list)) return list.filter((ref): ref is string => typeof ref === 'string' && ref !== '')
  const single = sub.source_feature
  return typeof single === 'string' && single !== '' ? [single] : []
}

interface ResolvedSource {
  id: string
  kind: ToolKind
  feature: Dict
  operation: 'add' | 'cut'
}

/**
 * The earlier features a feature-subject pattern repeats, with their expressions
 * resolved the way their own solves resolved them. The union is in document
 * order, not list order: the subject order is a property of the log, so moving
 * a chip cannot silently renumber instances. A missing or now-later source is
 * dropped with a warning (the fix is not in this editor); a suppressed or
 * unsupported source is refused by name, because those have a one-step fix and
 * must not pattern nothing.
 */
function resolveSources(
  patternFeatureId: string,
  refs: readonly string[],
  featuresById: Record<string, Dict>,
  variables: Record<string, number>,
  laterVariables: Record<string, number>,
  noun: string,
): { sources: ResolvedSource[]; dropped: string[] } {
  if (refs.length === 0) {
    throw new Error(`${noun}: source_features is required; pick one or more features to repeat`)
  }
  const order = Object.keys(featuresById)
  const patternAt = order.indexOf(patternFeatureId)
  const seen = new Set<string>()
  const sources: ResolvedSource[] = []
  const dropped: string[] = []
  for (const ref of refs) {
    const sourceId = stripRefSigil(ref, '@')
    if (sourceId === '' || seen.has(sourceId)) continue
    seen.add(sourceId)
    const source = featuresById[sourceId]
    if (source === undefined) {
      dropped.push(`${noun}: source feature '${sourceId}' does not exist; it was dropped`)
      continue
    }
    if (patternAt >= 0 && order.indexOf(sourceId) > patternAt) {
      dropped.push(
        `${noun}: the source feature '${sourceId}' comes after this ${noun}; it was dropped ` +
          `(move it up with reorder_features {featureId: '${sourceId}', before: '${patternFeatureId}'})`,
      )
      continue
    }
    if (source.suppressed === true) {
      throw new Error(`${noun}: the source feature '${sourceId}' is suppressed; unsuppress it to ${noun} it`)
    }
    const kind = String(source.kind ?? '')
    if (!isToolKind(kind)) {
      throw new Error(
        `${noun}: '${sourceId}' is a ${kind || 'feature without a kind'}; ` + sourceKindSentence(noun),
      )
    }
    const resolved = resolveFeatureExpressions(source, variables, laterVariables)
    if ('exception' in resolved) {
      throw new Error(`${noun}: the source feature '${sourceId}' has an unresolved value: ${resolved.exception}`)
    }
    const feature = resolved.feature
    const sub = (feature[kind] as Dict | undefined) ?? {}
    const operation = (sub.operation as string) ?? 'add'
    if (operation !== 'add' && operation !== 'cut') {
      throw new Error(
        `${noun}: the source feature '${sourceId}' has operation '${operation}'; ` +
          'repeat an add or a cut, not a feature that starts a new part',
      )
    }
    if (kind === 'extrude' && ((sub.termination as string) === 'up_to' || (sub.termination as string) === 'up_to_next')) {
      throw new Error(
        `${noun}: the source feature '${sourceId}' terminates ${sub.termination}, so its tool is trimmed once and the trim ` +
          'would travel with every copy; use a blind or through_all extrude instead',
      )
    }
    sources.push({ id: sourceId, kind, feature, operation })
  }
  sources.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return { sources, dropped }
}

/**
 * The body a feature-subject pattern already shaped. An authored target wins.
 * Without one, the candidates are the bodies the source created or modified;
 * one is the answer, none and several are refusals that name the fix rather than
 * picking a body by store order.
 */
function resolvePatternTarget(sourceId: string, explicitRef: string, partStore: Record<string, PartSolid>, noun: string): PartSolid {
  if (explicitRef) {
    try {
      return resolvePart(explicitRef, partStore)
    } catch (e) {
      swallowUnlessTrap(e)
      // A ref naming several bodies is a different diagnosis from a missing
      // one, and its own message lists the ids to choose between.
      if (e instanceof AmbiguousPartRefError) throw e
      throw new Error(`${noun}: target_body '${explicitRef}' does not name one part (${extractErrorMessage(e)})`)
    }
  }
  const candidates = Object.values(partStore).filter(
    (part) => part.created_by === sourceId || part.modified_by.includes(sourceId),
  )
  if (candidates.length === 0) {
    throw new Error(
      `${noun}: the source feature '${sourceId}' produced no part; ` +
        'check that it solved and comes before this feature',
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `${noun}: the source feature '${sourceId}' touched ${candidates.length} parts ` +
        `(${candidates.map((part) => part.id).join(', ')}); set target_body to one of them`,
    )
  }
  return candidates[0]
}

/** Release the scratch bodies a forced `new` solve registered, and their shapes. */
function releaseScratch(table: HandleTable, tools: PartSolid[]): void {
  for (const part of tools) {
    if (part.shape !== null && table.has(part.shape)) table.release(part.shape)
  }
}

/** One tool shape a source's forced `new` solve handed back, with its stable
 *  position in the instance numbering. */
interface SourceTool {
  sourceId: string
  operation: 'add' | 'cut'
  shape: OccShape
  rows: ReturnType<typeof readSourceFaceRows>
  order: number
}

/** One transformed tool copy: the shape and the identities it was minted with. */
interface CopyInstance {
  copy: number
  // The source the tool came from, so a cut-miss is named against the source
  // that contributed it as well as the grid copy.
  sourceId: string
  shape: OccShape
  names: NameMaps
}

/** Merge every selected copy's name maps into one tool map for the batch. */
function mergeCopyNames(copies: readonly CopyInstance[]): NameMaps {
  const merged = emptyShapeNames()
  for (const copy of copies) mergeShapeNames(merged, copy.names)
  return merged
}

/** Group instances by the 1-based copy number the failure text names. */
function groupByCopy(copies: readonly CopyInstance[]): Map<number, CopyInstance[]> {
  const groups = new Map<number, CopyInstance[]>()
  for (const copy of copies) {
    const group = groups.get(copy.copy)
    if (group === undefined) groups.set(copy.copy, [copy])
    else group.push(copy)
  }
  return groups
}

/** What applying one source's copies to one target body produced. */
interface TargetCopyResult {
  failures: string[]
  notes: string[]
  partIds: string[]
  appliedCopies: number
}

/**
 * Apply one source's transformed tools to one target body. The source's own
 * operation has already run once at solve time; this applies only the remaining
 * copies. Copies that refuse are named: some applied and some not is a partial
 * result, none applied is an error at the caller.
 */
function applyCopiesToTarget(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  featureId: string,
  target: PartSolid,
  copies: readonly CopyInstance[],
  operation: 'add' | 'cut',
  partStore: Record<string, PartSolid>,
  sourceId: string,
  noun: string,
  opName: string,
): TargetCopyResult {
  const targetId = target.id
  const failures: string[] = []
  const notes: string[] = []
  const copyLabel = (copy: number): string =>
    sourceId === '' ? `copy ${copy}` : `copy ${copy} (source '${sourceId}')`
  let selected = copies

  // A missed cut leaves the solid count unchanged, so a miss needs a signal.
  // The batch answers it from its own face history: a copy that removes
  // nothing contributes no tool face, so `toolsThatShaped` names the hit set
  // after the fact. The old per-copy Common probe cost 44 ms a copy (about
  // 14 s of the 325-hole pattern), so it is now paid only by the per-copy
  // fallback, which has no batch history to read. Add copies are never
  // misses: a disjoint one is a regular island, and the batch fallback below
  // lets the per-copy path mint it.
  const probeCutHits = (): CopyInstance[] => {
    const targetShape = table.get<OccShape>(target.shape!)
    const hits: CopyInstance[] = []
    for (const [copyNo, group] of groupByCopy(copies)) {
      // One heartbeat per copy: the probe is a full Common each, so this loop
      // alone is a long pass at high counts.
      markFeatureProgress()
      const overlapping = group.filter((copy) => shapesIntersect(oc, targetShape, copy.shape))
      if (overlapping.length === 0) {
        failures.push(`${copyLabel(copyNo)}: cut does not intersect any target part - nothing to remove`)
      } else {
        hits.push(...overlapping)
      }
    }
    return hits
  }

  // The old per-copy path, kept for the two shapes a batch cannot report per
  // copy: a copy that consumes the target, and a union that leaves islands.
  const applyIndividually = (): { partIds: string[]; appliedCopies: number } => {
    const attempted = operation === 'cut' ? probeCutHits() : selected
    let appliedCopies = 0
    const live = new Set<string>([targetId])
    let consumed = false
    for (const [copyNo, group] of groupByCopy(attempted)) {
      if (consumed) break
      markFeatureStart(featureId)
      let copyApplied = false
      for (const inst of group) {
        try {
          const result = applyPartOperation(oc, scope, table, {
            toolShape: inst.shape,
            partStore,
            operation,
            mergeTarget: targetId,
            partId: 'body_' + featureId,
            featureId,
            sketchId: target.sketch_id,
            profileQueries: target.profile_queries,
            faceNames: inst.names.faceNames,
            edgeNames: inst.names.edgeNames,
            faceAncestry: inst.names.faceAncestry,
            edgeAncestry: inst.names.edgeAncestry,
            capAncestry: inst.names.capAncestry,
            faceOwner: inst.names.faceOwner,
            edgeOwner: inst.names.edgeOwner,
            // The construction-name token, not the feature kind: keeping it is
            // what holds every feature-pattern copy's UUID now that the kind is
            // `linear_pattern`/`circular_pattern`. Only diagnostics read it.
            opName,
            // A pattern copy is the same geometry as its source body.
            precision: target.precision ?? null,
          })
          copyApplied = true
          const ids = result.body_ids ?? (result.body_id ? [result.body_id] : [])
          if (ids.length === 0) {
            // The copy consumed the whole target: nothing keeps the id and no
            // later copy has a body to land on.
            live.delete(targetId)
            consumed = true
            notes.push(`${noun}: ${copyLabel(copyNo)} removed all of part '${targetId}'; later copies were not applied`)
            break
          }
          for (const id of ids) live.add(id)
          if (result.solver_warning !== undefined && !notes.includes(result.solver_warning)) {
            notes.push(result.solver_warning)
          }
        } catch (e) {
          swallowUnlessTrap(e)
          // applyBodyOperation already prefixes its message with opName; the
          // copy prefix is the part the user needs, so drop the repeated name.
          const message = extractErrorMessage(e)
          const prefix = `${opName}: `
          const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message
          failures.push(`${copyLabel(copyNo)}: ${reason}`)
        }
      }
      if (copyApplied) appliedCopies++
    }
    return { partIds: [...live], appliedCopies }
  }

  // One boolean over every copy. A throw, a consumed target, or a result that
  // gained solids (the island case) falls back to the per-copy path so the
  // warning and the refusal stay exactly as they were.
  markFeatureStart(featureId)
  const targetShape = table.get<OccShape>(target.shape!)
  const targetNames = readPartNames(oc, scope, targetShape, target)
  let batched
  try {
    batched = booleanWithDiffMany(
      oc, scope, targetShape, selected.map((copy) => copy.shape),
      operation === 'add' ? 'fuse' : 'cut',
      { unifyFaces: !target.imported, precision: target.precision ?? null },
    )
  } catch (e) {
    swallowUnlessTrap(e)
    const fallback = applyIndividually()
    return { ...fallback, failures, notes }
  }
  const newShape = scope.track(batched.shape)
  const oldSolids = countSolids(oc, scope, targetShape)
  const newSolids = countSolids(oc, scope, newShape)
  if (newSolids === 0 || newSolids > oldSolids) {
    const fallback = applyIndividually()
    return { ...fallback, failures, notes }
  }

  // The batch's history is the cut-miss classification: a copy whose tool
  // left no face of its own removed nothing. Failures name the copy the same
  // way the probe did, and the batch result is unchanged (a disjoint tool is
  // a no-op in the cut).
  if (operation === 'cut') {
    const shaped = toolsThatShaped(oc, scope, selected.map((copy) => copy.shape), batched.faceOrigin)
    const kept: CopyInstance[] = []
    selected.forEach((copy, index) => {
      if (shaped.has(index)) kept.push(copy)
      else failures.push(`${copyLabel(copy.copy)}: cut does not intersect any target part - nothing to remove`)
    })
    if (kept.length === 0) return { partIds: [], appliedCopies: 0, failures, notes }
    selected = kept
  }

  const toolNames = mergeCopyNames(selected)
  const names = transferBooleanNames(oc, scope, {
    partShape: newShape,
    faceOrigin: batched.faceOrigin,
    targetFaceNames: targetNames.faceNames,
    targetFaceAncestry: target.face_ancestry ?? {},
    targetCapAncestry: target.face_cap_ancestry ?? {},
    targetFaceOwner: targetNames.faceOwner,
    targetEdgeOwner: targetNames.edgeOwner,
    toolFaceNames: toolNames.faceNames,
    toolFaceAncestry: toolNames.faceAncestry,
    toolCapAncestry: toolNames.capAncestry,
    toolFaceOwner: toolNames.faceOwner,
    toolEdgeOwner: toolNames.edgeOwner,
    // Every copy was already remapped to its own UUIDs, so nothing collides.
    toolCreatedBy: featureId,
    toolUuidScope: null,
  })
  let preferredFirst: OccShape | null = null
  if (operation === 'add') {
    const targetFaces = batched.faceOrigin
      .filter((origin) => !origin.fromTool)
      .map((origin) => origin.output as OccShape)
    preferredFirst = solidHoldingFaces(oc, scope, newShape, targetFaces)
  }
  const partIds = resplitPart(
    oc, scope, table, partStore, target, newShape, featureId, names, preferredFirst,
    target.precision ?? null,
  )
  // Several sources share one feature id; the last entry already names this
  // feature after the first source's apply, so do not grow the history twice.
  if (target.modified_by[target.modified_by.length - 1] !== featureId) target.modified_by.push(featureId)
  target.brep_diff = batched.diff
  if (brepDiffIsEmpty(batched.diff)) notes.push(`${noun}: operation produced no geometry change`)

  return { partIds, appliedCopies: groupByCopy(selected).size, failures, notes }
}

/**
 * Build every source's own tool by re-solving it with its operation forced to
 * `new` into a throwaway body store. The scratch bodies are pushed into the
 * caller's list as they are registered, so a throw halfway through still
 * releases what was built. Shared with the instance pattern's centroid
 * fallback, which needs the first source's tool without repeating the solve.
 */
function buildSourceTools(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  sources: readonly ResolvedSource[],
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
  scratchParts: PartSolid[],
  noun: string,
): SourceTool[] {
  const tools: SourceTool[] = []
  let order = 0
  for (const source of sources) {
    const sourceSub = (source.feature[source.kind] as Dict) ?? {}
    const scratch: Record<string, PartSolid> = {}
    // A through_all cut sizes its tool from the bodies its copies will cut,
    // which is this solve's real store rather than the empty scratch one. The
    // forced `new` is only how the tool is handed back, so the cut-only rule
    // judges the source's own operation. Keep the source's merge_target so its
    // own narrowing still applies; `new` ignores that key when it registers
    // the tool.
    const throughAllSource = source.kind === 'extrude' && (sourceSub.termination as string) === 'through_all'
      ? { operation: source.operation, parts: partStore }
      : undefined
    const toolSub: Dict = { ...sourceSub, operation: 'new' }
    if (throughAllSource === undefined) delete toolSub.merge_target
    const toolFeature: Dict = { ...source.feature, id: source.id, [source.kind]: toolSub }
    const built = source.kind === 'extrude'
      ? solveExtrude(
          oc, scope, table, toolFeature, globalRepo, scratch, undefined,
          throughAllSource === undefined ? undefined : { ...solveContext, throughAllSource },
        )
      : source.kind === 'wrap'
        // The wrap's target face is on the real parts, not in the scratch
        // store its tool is registered into.
        ? solveWrap(oc, scope, table, toolFeature, globalRepo, scratch, undefined, { targetParts: partStore })
        : TOOL_LEAVES[source.kind](oc, scope, table, toolFeature, globalRepo, scratch)
    if (built.status !== 'ok') {
      throw new Error(
        `${noun}: the source feature '${source.id}' could not provide its tool: ` +
          `${String(built.exception ?? built.status)}`,
      )
    }
    const sourceTools = Object.values(scratch)
    scratchParts.push(...sourceTools)
    if (sourceTools.length === 0) {
      throw new Error(`${noun}: the source feature '${source.id}' produced no solid to repeat`)
    }
    // Read once per tool, not per instance: the tool shape does not change
    // between copies.
    for (const part of sourceTools) {
      const shape = table.get<OccShape>(part.shape!)
      const names = readPartNames(oc, scope, shape, part)
      tools.push({
        sourceId: source.id,
        operation: source.operation,
        shape,
        rows: readSourceFaceRows(oc, scope, shape, names.faceNames, names.faceAncestry, names.capAncestry),
        order: order++,
      })
    }
  }
  return tools
}

/**
 * The volume centroid of the first source's own tool, or null when the source
 * names no tool. The instance pattern's reference fallback reads it so its
 * copies are measured from the geometry the source actually adds or cuts, not
 * from the whole body that feature shaped.
 */
export function firstSourceToolCentroid(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  sub: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
): Vec3 | null {
  const featureId = (feature.id as string) ?? ''
  const { sources } = resolveSources(
    featureId,
    sourceFeatureRefs(sub),
    featuresById,
    solveContext.variables,
    solveContext.laterVariables,
    'pattern',
  )
  if (sources.length === 0) return null
  const scratchParts: PartSolid[] = []
  try {
    const tools = buildSourceTools(
      oc, scope, table, [sources[0]], globalRepo, partStore, solveContext, scratchParts, 'pattern',
    )
    if (tools.length === 0) return null
    return solidCentroid(oc, scope, tools[0].shape)
  } finally {
    releaseScratch(table, scratchParts)
  }
}

interface TargetPlan {
  target: PartSolid
  sources: ResolvedSource[]
}

/**
 * Solve a feature-subject copy run: a pattern repeats an earlier feature's own
 * add or cut at every instance, a mirror reflects it once. Each copy is the
 * source's tool rigidly transformed. Copies that refuse are named: some applied
 * and some not is a `partial` result, none applied is an error, so a half-applied
 * pattern never reads as complete. A mirror's own transform can land a copy on
 * its source; the leaf's coincidence predicate turns that into a quiet warning.
 */
export function solveFeaturePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  sub: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
  copies: readonly PatternCopy[],
  warnings: readonly string[],
  extra: Dict = {},
  options: FeatureCopiesOptions = {},
): PatternResult {
  const featureId = (feature.id as string) ?? ''
  const noun = options.noun ?? 'pattern'
  const opName = options.opName ?? 'pattern'
  const { sources, dropped } = resolveSources(
    featureId,
    sourceFeatureRefs(sub),
    featuresById,
    solveContext.variables,
    solveContext.laterVariables,
    noun,
  )
  if (sources.length === 0) {
    throw new Error(`${noun}: no source features remain; ${dropped.join('; ') || 'nothing to repeat'}`)
  }
  const notes: string[] = [...dropped, ...warnings]
  // Resolve the targets before any tool is built: with no copies to apply (count
  // 1, or a skip list covering every instance) the source problems and the
  // target still have to be named, but no tool needs building at all.
  const explicitTargetRef = (sub.target_body as string) ?? ''
  const plans: TargetPlan[] = []
  if (explicitTargetRef) {
    plans.push({ target: resolvePatternTarget(sources[0].id, explicitTargetRef, partStore, noun), sources })
  } else {
    // Sources that shaped the same body share one plan, so their tools land
    // in document order on that body. Sources that shaped different bodies
    // each keep their own.
    const byTarget = new Map<string, TargetPlan>()
    for (const source of sources) {
      const target = resolvePatternTarget(source.id, '', partStore, noun)
      const plan = byTarget.get(target.id)
      if (plan === undefined) byTarget.set(target.id, { target, sources: [source] })
      else plan.sources.push(source)
    }
    plans.push(...byTarget.values())
  }
  const operations = new Set(sources.map((source) => source.operation))
  if (copies.length === 0) {
    // The quiet no-op: the sources' own operations already ran at their solve,
    // so the bodies stay exactly as they were. No warning unless a source was
    // dropped or a skip entry is stale.
    const ids = plans.map((plan) => plan.target.id).filter((id) => partStore[id] !== undefined)
    const result: PatternResult = {
      status: 'ok',
      body_id: ids[0] ?? '',
      body_ids: ids,
      operation: operations.size === 1 ? [...operations][0] : 'mixed',
      ...extra,
    }
    if (notes.length > 0) result.solver_warning = notes.join('; ')
    return result
  }
  const scratchParts: PartSolid[] = []
  try {
    const tools = buildSourceTools(
      oc, scope, table, sources, globalRepo, partStore, solveContext, scratchParts, noun,
    )

    const failures: string[] = []
    const resultIds = new Set<string>()
    const coincident: string[] = []
    let appliedCopies = 0
    const totalCopies = copies.length * sources.length
    for (const plan of plans) {
      const planSources = new Set(plan.sources.map((source) => source.id))
      const planTools = tools.filter((tool) => planSources.has(tool.sourceId))
      const copiesBySource = new Map<string, CopyInstance[]>()
      for (const [index, copy] of copies.entries()) {
        for (const tool of planTools) {
          markFeatureStart(featureId)
          const { shape: rawShape, builder } = transformCopyWithMapping(oc, scope, tool.shape, copy.trsf)
          const shape = scope.track(rawShape)
          // A copy that lands on its own source changes nothing: the source's
          // own operation already produced that geometry. A boolean would read
          // it as an ordinary miss, so the leaf's predicate names it here.
          if (options.coincides !== undefined && options.coincides(tool.shape, shape)) {
            coincident.push(
              `${noun}: the mirrored feature '${tool.sourceId}' coincides with the original; nothing changed`,
            )
            continue
          }
          // The copy's key keeps its UUIDs when an earlier instance is skipped
          // or a centered run grows. Several sources share one copy key, so a
          // source's tool takes its own slot in the path.
          const nameKey = tools.length > 1 ? `${copy.key}|s${tool.order}` : copy.key
          const names = rebuildNamesForTransformedCopy(oc, scope, shape, tool.rows, featureId, nameKey, builder)
          const list = copiesBySource.get(tool.sourceId)
          const instanceCopy = { copy: index + 1, sourceId: tool.sourceId, shape, names }
          if (list === undefined) copiesBySource.set(tool.sourceId, [instanceCopy])
          else list.push(instanceCopy)
        }
      }
      for (const source of plan.sources) {
        const target = partStore[plan.target.id]
        if (target === undefined) {
          notes.push(
            `${noun}: part '${plan.target.id}' was removed by an earlier source; ` +
              `'${source.id}' was not applied`,
          )
          break
        }
        const sourceCopies = copiesBySource.get(source.id) ?? []
        // Every copy of this source was a coincidence, so there is nothing to
        // apply: the target already holds the geometry.
        if (sourceCopies.length === 0) continue
        const result = applyCopiesToTarget(
          oc, scope, table, featureId, target, sourceCopies,
          source.operation, partStore, sources.length > 1 ? source.id : '', noun, opName,
        )
        failures.push(...result.failures)
        notes.push(...result.notes)
        appliedCopies += result.appliedCopies
        for (const id of result.partIds) resultIds.add(id)
      }
    }

    if (appliedCopies === 0) {
      if (coincident.length > 0 && failures.length === 0) {
        // The mirror reflected the source onto itself: the feature is a quiet
        // no-op, not an error, and the bodies stay exactly as they were.
        const ids = plans.map((plan) => plan.target.id).filter((id) => partStore[id] !== undefined)
        const noop: PatternResult = {
          status: 'ok',
          body_id: ids[0] ?? '',
          body_ids: ids,
          operation: operations.size === 1 ? [...operations][0] : 'mixed',
        }
        const allNotes = [...notes, ...coincident]
        if (allNotes.length > 0) noop.solver_warning = allNotes.join('; ')
        return noop
      }
      throw new Error(`${noun}: no copy was applied; ${failures[0] ?? 'nothing to apply'}`)
    }
    const liveIds = [...resultIds].filter((id) => partStore[id] !== undefined)
    const result: PatternResult = {
      status: failures.length > 0 ? 'partial' : 'ok',
      body_id: liveIds[0] ?? plans[0]?.target.id ?? '',
      body_ids: liveIds,
      operation: operations.size === 1 ? [...operations][0] : 'mixed',
      ...extra,
    }
    if (failures.length > 0) {
      result.exception = `${noun}: ${appliedCopies}/${totalCopies} copies applied; ${failures.join('; ')}`
    }
    const allNotes = [...notes, ...coincident]
    if (allNotes.length > 0) result.solver_warning = allNotes.join('; ')
    return result
  } finally {
    // Every scratch body a forced `new` solve registered, including any made
    // before a throw: they are this leaf's transient tool, never part rows.
    releaseScratch(table, scratchParts)
  }
}
