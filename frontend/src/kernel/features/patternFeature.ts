// The feature subject of a pattern: repeat one or more earlier solid-producing
// features' own add or cut inside the body each feature already shaped. This is
// the half pattern.ts delegates to; the body subject lives in patternPart.ts and
// both share the copies the pattern kind built. The sub-def arrives as a
// parameter, so every pattern kind reuses this leaf without teaching it a new
// sub-dict key, and the mirror's feature subject calls it with one reflect
// transform (options.noun/opName say "mirror" in the messages).
//
// Each source's tool is obtained by re-solving the source with its operation
// forced to `new` into a throwaway body store. A hole has no operation: its own
// tool mode hands back the compound of the per-site cutters it actually cut
// with, named by the hole's bore/floor/mouth roles and carrying its cosmetic
// thread. Those scratch bodies are released at the end of this solve; they never
// enter the real store, so no part row or checkpoint sees them.
//
// Several sources are a union: every source's tool is applied at every grid
// instance, in the order the sources sit in the feature log (then each source's
// own output order). The first source's first produced body is the instance-0
// seed, because the grid always leaves the seed slot to the sources. A source
// that no longer exists or now sits after the pattern is dropped with a named
// warning on the result; a pattern left with no source is refused by name.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccPntValue, OccShape, OccTrsf } from '../occ/occTypes'
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
import { solveHole } from './hole'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import { stripRefSigil } from '@/utils/refSigil'
import { solidCentroid, type Vec3 } from '../occ/primitives'
import { arrayInstancePath, mintFaceUuid } from '../constructionName'
import type { ThreadDisplayData, ThreadSiteData } from '@/types/cad'
import type { Dict, PatternCopy } from './pattern'
import { isPatternSourceKind, patternSourceKindSentence, type PatternSourceKind } from './patternSourceKinds'

export interface PatternResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  operation?: string
  solver_warning?: string
  exception?: string
  // The copies' tapped runs when a source was a threaded hole; the source's
  // own runs stay on its result.
  thread?: ThreadDisplayData
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

/** The kinds whose leaf builds a tool and routes it through applyPartOperation
 *  with add/cut/new, so `operation: new` hands the same tool back as a body. A
 *  hole has no operation: its tool mode hands back the per-site cutters it
 *  actually cut with, compounded and fused where two bores overlap. */
const TOOL_LEAVES = {
  extrude: solveExtrude,
  revolve: solveRevolve,
  sweep: solveSweep,
  wrap: solveWrap,
  hole: solveHole,
} satisfies Record<PatternSourceKind, (...args: never[]) => { status: string }>

type ToolKind = PatternSourceKind

/** The shared kind list is the gate; the satisfies above fails to compile when
 *  it gains a kind this table lacks, so the two cannot drift apart. */
function isToolKind(kind: string): kind is ToolKind {
  return isPatternSourceKind(kind)
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
        `${noun}: '${sourceId}' is a ${kind || 'feature without a kind'}; ` + patternSourceKindSentence(noun),
      )
    }
    const resolved = resolveFeatureExpressions(source, variables, laterVariables)
    if ('exception' in resolved) {
      throw new Error(`${noun}: the source feature '${sourceId}' has an unresolved value: ${resolved.exception}`)
    }
    const feature = resolved.feature
    const sub = (feature[kind] as Dict | undefined) ?? {}
    // A hole has no operation field; its only meaning is a cut. Do not invent
    // the key on the row: the source's own solve is the authority.
    let operation: 'add' | 'cut'
    if (kind === 'hole') {
      operation = 'cut'
    } else {
      const authored = (sub.operation as string) ?? 'add'
      if (authored !== 'add' && authored !== 'cut') {
        throw new Error(
          `${noun}: the source feature '${sourceId}' has operation '${authored}'; ` +
            'repeat an add or a cut, not a feature that starts a new part',
        )
      }
      operation = authored
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
  // A threaded hole's tapped runs, in the source's own coordinates. The copies
  // transform them, so a patterned bore shades as threaded.
  thread?: ThreadDisplayData
  // A through_all hole's resolved drill axis. Its tool was sized with one span
  // along this axis, so a copy that turns the axis cannot reach through.
  throughAxis?: Vec3
}

/** One transformed tool copy: the shape and the identities it was minted with. */
interface CopyInstance {
  copy: number
  // The source the tool came from, so a cut-miss is named against the source
  // that contributed it as well as the grid copy.
  sourceId: string
  shape: OccShape
  names: NameMaps
  // The instance naming key the copy's UUIDs were minted under, so a thread run
  // can name the bore face this copy leaves.
  nameKey: string
  // The placement itself, for the same reason: a thread run's centre and axis
  // go through it.
  trsf: OccTrsf
  thread?: ThreadDisplayData
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
  // The copies that really contributed, so a thread can ride them and not a
  // skipped instance or a miss.
  applied: CopyInstance[]
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
  const applyIndividually = (): { partIds: string[]; appliedCopies: number; applied: CopyInstance[] } => {
    const attempted = operation === 'cut' ? probeCutHits() : selected
    let appliedCopies = 0
    const applied: CopyInstance[] = []
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
          applied.push(inst)
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
          // applyPartOperation already prefixes its message with opName; the
          // copy prefix is the part the user needs, so drop the repeated name.
          const message = extractErrorMessage(e)
          const prefix = `${opName}: `
          const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message
          failures.push(`${copyLabel(copyNo)}: ${reason}`)
        }
      }
      if (copyApplied) appliedCopies++
    }
    return { partIds: [...live], appliedCopies, applied }
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
    if (kept.length === 0) return { partIds: [], appliedCopies: 0, applied: [], failures, notes }
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

  return { partIds, appliedCopies: groupByCopy(selected).size, applied: [...selected], failures, notes }
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
  featuresById: Record<string, Dict>,
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
    // A hole has no operation of its own and its tool mode reads the real store
    // directly, so its sub-def is handed over untouched rather than forced to
    // `new` (a key the leaf ignores, but the row never carries one).
    const toolSub: Dict = source.kind === 'hole' ? { ...sourceSub } : { ...sourceSub, operation: 'new' }
    if (throughAllSource === undefined) delete toolSub.merge_target
    const toolFeature: Dict = { ...source.feature, id: source.id, [source.kind]: toolSub }
    const built = source.kind === 'extrude'
      ? solveExtrude(
          oc, scope, table, toolFeature, globalRepo, scratch, featuresById,
          throughAllSource === undefined ? undefined : { ...solveContext, throughAllSource },
        )
      : source.kind === 'wrap'
        // A wrap's operation also signs its height, so the forced `new` must not
        // flip a cut's tool out of the material; its target comes from the record
        // its own solve left (the real store only as a fallback).
        ? solveWrap(oc, scope, table, toolFeature, globalRepo, scratch, featuresById, {
            ...solveContext, rebuild: { operation: source.operation, parts: partStore },
          })
        : source.kind === 'hole'
          // The hole has no operation to force: its tool mode resolves the
          // sites, direction and through_all span against the real store, builds
          // the per-site cutters it actually cut with, and registers their
          // compound (or fuse) as the one scratch body, names and thread and all.
          ? solveHole(
              oc, scope, table, toolFeature, globalRepo, scratch, featuresById,
              { ...solveContext, toolOnly: { parts: partStore } },
            )
          : TOOL_LEAVES[source.kind](oc, scope, table, toolFeature, globalRepo, scratch)
    if (built.status !== 'ok') {
      throw new Error(
        `${noun}: the source feature '${source.id}' could not provide its tool: ` +
          `${String(built.exception ?? built.status)}`,
      )
    }
    const builtThread = source.kind === 'hole'
      ? (built as { thread?: ThreadDisplayData }).thread
      : undefined
    // A through_all hole's tool carries one span, so the leaf must know which
    // way that span runs to refuse a copy that turns it.
    const throughAxis = source.kind === 'hole' && (sourceSub.depth_mode as string) === 'through_all'
      ? (built as { drill_axis?: Vec3 }).drill_axis
      : undefined
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
        thread: builtThread,
        throughAxis,
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
      oc, scope, table, [sources[0]], globalRepo, partStore, featuresById, solveContext, scratchParts, 'pattern',
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

/** A copy's rigid transform applied to one point. */
function transformedPoint(oc: OccModule, scope: DisposeScope, trsf: OccTrsf, point: readonly number[]): Vec3 {
  const p = scope.track(new oc.gp_Pnt_3(point[0], point[1], point[2])) as OccPntValue
  p.Transform(trsf)
  return [p.X(), p.Y(), p.Z()]
}

/** A copy's transform applied to a direction: two points, so the translation
 *  cancels. Rigid transforms preserve length (a mirror reflects the sense). */
function transformedDirection(oc: OccModule, scope: DisposeScope, trsf: OccTrsf, direction: Vec3): Vec3 {
  const from = transformedPoint(oc, scope, trsf, [0, 0, 0])
  const to = transformedPoint(oc, scope, trsf, direction)
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const length = Math.hypot(dx, dy, dz)
  return length > 1e-12 ? [dx / length, dy / length, dz / length] : [0, 0, 0]
}

/**
 * The tapped runs the pattern's own result reports: the source hole's runs
 * carried through each copy that really applied. The centre goes through the
 * instance transform, the axis is the transformed direction (a mirror reflects
 * it), and the bore UUID is the copy's remapped bore, so the viewport shades
 * the wall the pattern left. A skipped instance or a missed copy contributes
 * nothing, exactly as it contributed no geometry.
 */
function threadRunsOfCopies(
  oc: OccModule,
  scope: DisposeScope,
  featureId: string,
  applied: readonly CopyInstance[],
): ThreadDisplayData | null {
  const runs: ThreadSiteData[] = []
  let meta: Pick<ThreadDisplayData, 'designation' | 'nominal' | 'pitch'> | null = null
  for (const copy of applied) {
    if (copy.thread === undefined) continue
    meta ??= {
      designation: copy.thread.designation,
      nominal: copy.thread.nominal,
      pitch: copy.thread.pitch,
    }
    for (const site of copy.thread.sites) {
      const center = transformedPoint(oc, scope, copy.trsf, site.center)
      const ahead = transformedPoint(oc, scope, copy.trsf, [
        site.center[0] + site.axis[0],
        site.center[1] + site.axis[1],
        site.center[2] + site.axis[2],
      ])
      const dx = ahead[0] - center[0]
      const dy = ahead[1] - center[1]
      const dz = ahead[2] - center[2]
      const length = Math.hypot(dx, dy, dz)
      if (!(length > 1e-12)) continue
      runs.push({
        center: [center[0], center[1], center[2]],
        axis: [dx / length, dy / length, dz / length],
        radius: site.radius,
        length: site.length,
        // The instance path the copy's face UUIDs were minted under, so the run
        // names the wall this copy left rather than the source's.
        bore_uuids: site.bore_uuids.map((uuid) => mintFaceUuid(arrayInstancePath(uuid, featureId, copy.nameKey))),
      })
    }
  }
  if (meta === null || runs.length === 0) return null
  return { ...meta, sites: runs }
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
      oc, scope, table, sources, globalRepo, partStore, featuresById, solveContext, scratchParts, noun,
    )

    const failures: string[] = []
    const resultIds = new Set<string>()
    const coincident: string[] = []
    const appliedInstances: CopyInstance[] = []
    let appliedCopies = 0
    const totalCopies = copies.length * sources.length
    for (const plan of plans) {
      const planSources = new Set(plan.sources.map((source) => source.id))
      const planTools = tools.filter((tool) => planSources.has(tool.sourceId))
      const copiesBySource = new Map<string, CopyInstance[]>()
      for (const [index, copy] of copies.entries()) {
        for (const tool of planTools) {
          markFeatureStart(featureId)
          // A through_all hole's tool carries one span along its own axis; a
          // copy that turns that axis anywhere between parallel and
          // anti-parallel would cut a shorter chord than the body needs, so it
          // is refused by name instead of silently leaving a blind bore.
          if (tool.throughAxis !== undefined) {
            const copiedAxis = transformedDirection(oc, scope, copy.trsf, tool.throughAxis)
            const dot = Math.abs(
              copiedAxis[0] * tool.throughAxis[0] +
              copiedAxis[1] * tool.throughAxis[1] +
              copiedAxis[2] * tool.throughAxis[2],
            )
            if (dot < 1 - 1e-9) {
              failures.push(
                `${noun}: copy ${index + 1} (source '${tool.sourceId}') turns the through_all hole's drill axis, ` +
                  'so its bore cannot span the body with the tool\'s one span; keep the drill axis parallel or ' +
                  'use a blind hole',
              )
              continue
            }
          }
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
          const instanceCopy: CopyInstance = {
            copy: index + 1, sourceId: tool.sourceId, shape, names, nameKey, trsf: copy.trsf, thread: tool.thread,
          }
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
        appliedInstances.push(...result.applied)
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
    // A threaded hole's copies shade their own walls. Only the copies appear
    // here: the source's own run stays on the source hole's result.
    const thread = threadRunsOfCopies(oc, scope, featureId, appliedInstances)
    if (thread !== null) result.thread = thread
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
