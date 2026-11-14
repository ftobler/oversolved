// The feature subject of a pattern: repeat one or more earlier solid-producing
// features' own add or cut inside the body each feature already shaped. This is
// the half pattern.ts delegates to; the body subject lives in patternBody.ts and
// both share the transforms pattern.ts builds.
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
import type { OccModule, OccShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousBodyRefError, resolveBody } from './shared/bodyResolution'
import { applyBodyOperation } from './bodyOps'
import {
  readSourceFaceRows, rebuildNamesForTransformedCopy, transformCopyWithMapping, type NameMaps,
} from '../occ/transformLineage'
import { emptyShapeNames, mergeShapeNames, readBodyNames } from '../occ/bodyNames'
import { booleanWithDiffMany, countSolids, shapesIntersect, toolsThatShaped } from '../occ/booleans'
import { transferBooleanNames } from './booleanLineage'
import { resplitBody, solidHoldingFaces } from './bodySplit'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { markFeatureStart, markFeatureProgress } from '../featureProgress'
import { resolveFeatureExpressions } from '../featureExpressions'
import { solveExtrude } from './extrude'
import { solveRevolve } from './revolve'
import { solveSweep } from './sweep'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import { stripRefSigil } from '@/utils/refSigil'
import type { Dict } from './pattern'

export interface PatternResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  operation?: string
  solver_warning?: string
  exception?: string
}

/** The kinds whose leaf builds a tool and routes it through applyBodyOperation
 *  with add/cut/new, so `operation: new` hands the same tool back as a body. */
const TOOL_LEAVES = {
  extrude: solveExtrude,
  revolve: solveRevolve,
  sweep: solveSweep,
} as const

type ToolKind = keyof typeof TOOL_LEAVES

function isToolKind(kind: string): kind is ToolKind {
  return Object.hasOwn(TOOL_LEAVES, kind)
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
): { sources: ResolvedSource[]; dropped: string[] } {
  if (refs.length === 0) {
    throw new Error('pattern: source_features is required; pick one or more features to repeat')
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
      dropped.push(`pattern: source feature '${sourceId}' does not exist; it was dropped`)
      continue
    }
    if (patternAt >= 0 && order.indexOf(sourceId) > patternAt) {
      dropped.push(
        `pattern: the source feature '${sourceId}' comes after this pattern; it was dropped ` +
          `(move it up with reorder_features {featureId: '${sourceId}', before: '${patternFeatureId}'})`,
      )
      continue
    }
    if (source.suppressed === true) {
      throw new Error(`pattern: the source feature '${sourceId}' is suppressed; unsuppress it to pattern it`)
    }
    const kind = String(source.kind ?? '')
    if (!isToolKind(kind)) {
      throw new Error(
        `pattern: '${sourceId}' is a ${kind || 'feature without a kind'}; ` +
          'a feature pattern repeats an extrude, revolve or sweep',
      )
    }
    const resolved = resolveFeatureExpressions(source, variables, laterVariables)
    if ('exception' in resolved) {
      throw new Error(`pattern: the source feature '${sourceId}' has an unresolved value: ${resolved.exception}`)
    }
    const feature = resolved.feature
    const sub = (feature[kind] as Dict | undefined) ?? {}
    const operation = (sub.operation as string) ?? 'add'
    if (operation !== 'add' && operation !== 'cut') {
      throw new Error(
        `pattern: the source feature '${sourceId}' has operation '${operation}'; ` +
          'pattern an add or a cut, not a feature that starts a new body',
      )
    }
    if (kind === 'extrude' && ((sub.termination as string) === 'up_to' || (sub.termination as string) === 'up_to_next')) {
      throw new Error(
        `pattern: the source feature '${sourceId}' terminates ${sub.termination}, so its tool is trimmed once and the trim ` +
          'would travel with every copy; pattern a blind or through_all extrude instead',
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
function resolvePatternTarget(sourceId: string, explicitRef: string, bodyStore: Record<string, Body>): Body {
  if (explicitRef) {
    try {
      return resolveBody(explicitRef, bodyStore)
    } catch (e) {
      swallowUnlessTrap(e)
      // A ref naming several bodies is a different diagnosis from a missing
      // one, and its own message lists the ids to choose between.
      if (e instanceof AmbiguousBodyRefError) throw e
      throw new Error(`pattern: target_body '${explicitRef}' does not name one body (${extractErrorMessage(e)})`)
    }
  }
  const candidates = Object.values(bodyStore).filter(
    (body) => body.created_by === sourceId || body.modified_by.includes(sourceId),
  )
  if (candidates.length === 0) {
    throw new Error(
      `pattern: the source feature '${sourceId}' produced no body; ` +
        'check that it solved and comes before this pattern',
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `pattern: the source feature '${sourceId}' touched ${candidates.length} bodies ` +
        `(${candidates.map((body) => body.id).join(', ')}); set target_body to one of them`,
    )
  }
  return candidates[0]
}

/** Release the scratch bodies a forced `new` solve registered, and their shapes. */
function releaseScratch(table: HandleTable, tools: Body[]): void {
  for (const body of tools) {
    if (body.shape !== null && table.has(body.shape)) table.release(body.shape)
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
  bodyIds: string[]
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
  target: Body,
  copies: readonly CopyInstance[],
  operation: 'add' | 'cut',
  bodyStore: Record<string, Body>,
  sourceId: string,
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
        failures.push(`${copyLabel(copyNo)}: cut does not intersect any target body - nothing to remove`)
      } else {
        hits.push(...overlapping)
      }
    }
    return hits
  }

  // The old per-copy path, kept for the two shapes a batch cannot report per
  // copy: a copy that consumes the target, and a union that leaves islands.
  const applyIndividually = (): { bodyIds: string[]; appliedCopies: number } => {
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
          const result = applyBodyOperation(oc, scope, table, {
            toolShape: inst.shape,
            bodyStore,
            operation,
            mergeTarget: targetId,
            bodyId: 'body_' + featureId,
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
            opName: 'pattern',
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
            notes.push(`pattern: ${copyLabel(copyNo)} removed all of body '${targetId}'; later copies were not applied`)
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
          const reason = extractErrorMessage(e).replace(/^pattern: /, '')
          failures.push(`${copyLabel(copyNo)}: ${reason}`)
        }
      }
      if (copyApplied) appliedCopies++
    }
    return { bodyIds: [...live], appliedCopies }
  }

  // One boolean over every copy. A throw, a consumed target, or a result that
  // gained solids (the island case) falls back to the per-copy path so the
  // warning and the refusal stay exactly as they were.
  markFeatureStart(featureId)
  const targetShape = table.get<OccShape>(target.shape!)
  const targetNames = readBodyNames(oc, scope, targetShape, target)
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
      else failures.push(`${copyLabel(copy.copy)}: cut does not intersect any target body - nothing to remove`)
    })
    if (kept.length === 0) return { bodyIds: [], appliedCopies: 0, failures, notes }
    selected = kept
  }

  const toolNames = mergeCopyNames(selected)
  const names = transferBooleanNames(oc, scope, {
    bodyShape: newShape,
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
  const bodyIds = resplitBody(
    oc, scope, table, bodyStore, target, newShape, featureId, names, preferredFirst,
    target.precision ?? null,
  )
  // Several sources share one feature id; the last entry already names this
  // feature after the first source's apply, so do not grow the history twice.
  if (target.modified_by[target.modified_by.length - 1] !== featureId) target.modified_by.push(featureId)
  target.brep_diff = batched.diff
  if (brepDiffIsEmpty(batched.diff)) notes.push('pattern: operation produced no geometry change')

  return { bodyIds, appliedCopies: groupByCopy(selected).size, failures, notes }
}

interface TargetPlan {
  target: Body
  sources: ResolvedSource[]
}

/**
 * Solve a feature-subject pattern. Each source's operation is applied
 * `count - 1` more times, each with the source's tool rigidly transformed.
 * Copies that refuse are named: some applied and some not is a `partial`
 * result, none applied is an error, so a half-applied pattern never reads as
 * complete.
 */
export function solveFeaturePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
  transforms: OccTrsf[],
): PatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.pattern as Dict) ?? {}
  const { sources, dropped } = resolveSources(
    featureId,
    sourceFeatureRefs(sub),
    featuresById,
    solveContext.variables,
    solveContext.laterVariables,
  )
  if (sources.length === 0) {
    throw new Error(`pattern: no source features remain; ${dropped.join('; ') || 'nothing to pattern'}`)
  }
  const notes: string[] = [...dropped]
  const scratchBodies: Body[] = []
  const tools: SourceTool[] = []
  try {
    let order = 0
    for (const source of sources) {
      const sourceSub = (source.feature[source.kind] as Dict) ?? {}
      const scratch: Record<string, Body> = {}
      // A through_all cut sizes its tool from the bodies its copies will cut,
      // which is this solve's real store rather than the empty scratch one. The
      // forced `new` is only how the tool is handed back, so the cut-only rule
      // judges the source's own operation. Keep the source's merge_target so its
      // own narrowing still applies; `new` ignores that key when it registers
      // the tool.
      const throughAllSource = source.kind === 'extrude' && (sourceSub.termination as string) === 'through_all'
        ? { operation: source.operation, bodies: bodyStore }
        : undefined
      const toolSub: Dict = { ...sourceSub, operation: 'new' }
      if (throughAllSource === undefined) delete toolSub.merge_target
      const toolFeature: Dict = { ...source.feature, id: source.id, [source.kind]: toolSub }
      const built = source.kind === 'extrude'
        ? solveExtrude(
            oc, scope, table, toolFeature, globalRepo, scratch, undefined,
            throughAllSource === undefined ? undefined : { ...solveContext, throughAllSource },
          )
        : TOOL_LEAVES[source.kind](oc, scope, table, toolFeature, globalRepo, scratch)
      if (built.status !== 'ok') {
        throw new Error(
          `pattern: the source feature '${source.id}' could not provide its tool: ` +
            `${String(built.exception ?? built.status)}`,
        )
      }
      const sourceTools = Object.values(scratch)
      scratchBodies.push(...sourceTools)
      if (sourceTools.length === 0) {
        throw new Error(`pattern: the source feature '${source.id}' produced no solid to repeat`)
      }
      // Read once per tool, not per instance: the tool shape does not change
      // between copies.
      for (const body of sourceTools) {
        const shape = table.get<OccShape>(body.shape!)
        const names = readBodyNames(oc, scope, shape, body)
        tools.push({
          sourceId: source.id,
          operation: source.operation,
          shape,
          rows: readSourceFaceRows(oc, scope, shape, names.faceNames, names.faceAncestry, names.capAncestry),
          order: order++,
        })
      }
    }

    const explicitTargetRef = (sub.target_body as string) ?? ''
    const plans: TargetPlan[] = []
    if (explicitTargetRef) {
      plans.push({ target: resolvePatternTarget(sources[0].id, explicitTargetRef, bodyStore), sources })
    } else {
      // Sources that shaped the same body share one plan, so their tools land
      // in document order on that body. Sources that shaped different bodies
      // each keep their own.
      const byTarget = new Map<string, TargetPlan>()
      for (const source of sources) {
        const target = resolvePatternTarget(source.id, '', bodyStore)
        const plan = byTarget.get(target.id)
        if (plan === undefined) byTarget.set(target.id, { target, sources: [source] })
        else plan.sources.push(source)
      }
      plans.push(...byTarget.values())
    }

    const failures: string[] = []
    const resultIds = new Set<string>()
    let appliedCopies = 0
    const totalCopies = transforms.length * sources.length
    for (const plan of plans) {
      const planSources = new Set(plan.sources.map((source) => source.id))
      const planTools = tools.filter((tool) => planSources.has(tool.sourceId))
      const copiesBySource = new Map<string, CopyInstance[]>()
      for (let copy = 1; copy <= transforms.length; copy++) {
        for (const tool of planTools) {
          markFeatureStart(featureId)
          const { shape: rawShape, builder } = transformCopyWithMapping(oc, scope, tool.shape, transforms[copy - 1])
          const shape = scope.track(rawShape)
          // The instance index is global across sources so a source's UUIDs do
          // not move when a sibling source's target has to be repaired.
          const instance = (copy - 1) * tools.length + tool.order
          const names = rebuildNamesForTransformedCopy(oc, scope, shape, tool.rows, featureId, instance, builder)
          const list = copiesBySource.get(tool.sourceId)
          const instanceCopy = { copy, sourceId: tool.sourceId, shape, names }
          if (list === undefined) copiesBySource.set(tool.sourceId, [instanceCopy])
          else list.push(instanceCopy)
        }
      }
      for (const source of plan.sources) {
        const target = bodyStore[plan.target.id]
        if (target === undefined) {
          notes.push(
            `pattern: body '${plan.target.id}' was removed by an earlier source; ` +
              `'${source.id}' was not applied`,
          )
          break
        }
        const result = applyCopiesToTarget(
          oc, scope, table, featureId, target, copiesBySource.get(source.id) ?? [],
          source.operation, bodyStore, sources.length > 1 ? source.id : '',
        )
        failures.push(...result.failures)
        notes.push(...result.notes)
        appliedCopies += result.appliedCopies
        for (const id of result.bodyIds) resultIds.add(id)
      }
    }

    if (appliedCopies === 0) {
      throw new Error(`pattern: no copy was applied; ${failures[0] ?? 'nothing to apply'}`)
    }
    const liveIds = [...resultIds].filter((id) => bodyStore[id] !== undefined)
    const operations = new Set(sources.map((source) => source.operation))
    const result: PatternResult = {
      status: failures.length > 0 ? 'partial' : 'ok',
      body_id: liveIds[0] ?? plans[0]?.target.id ?? '',
      body_ids: liveIds,
      operation: operations.size === 1 ? [...operations][0] : 'mixed',
    }
    if (failures.length > 0) {
      result.exception = `pattern: ${appliedCopies}/${totalCopies} copies applied; ${failures.join('; ')}`
    }
    if (notes.length > 0) result.solver_warning = notes.join('; ')
    return result
  } finally {
    // Every scratch body a forced `new` solve registered, including any made
    // before a throw: they are this leaf's transient tool, never part rows.
    releaseScratch(table, scratchBodies)
  }
}
