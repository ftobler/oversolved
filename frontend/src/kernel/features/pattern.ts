// The pattern leaf. It repeats one subject through a grid of rigid instance
// transforms. The subject is the authored choice:
//
// - `body` copies a whole body. `operation: add` fuses the copies into the
//   source body and `operation: new` mints one body per copy; that half lives in
//   patternBody.ts.
// - `feature` repeats an earlier solid-producing feature's own add or cut
//   inside the body that feature already shaped. A body array plus a boolean
//   can produce the same geometry, but it needs the material as its own body
//   first and a merge afterwards; this subject asks the kernel for the source
//   feature's tool once and applies that tool at each copy position through the
//   same `applyBodyOperation` every producer uses.
//
// The source feature's tool is obtained by re-solving the source feature with
// its operation forced to `new` into a throwaway body store: the same leaf, the
// same profile resolution and the same names, with no second geometry builder.
// Those scratch bodies are released at the end of this solve; they never enter
// the real store, so no part row or checkpoint sees them.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousBodyRefError, resolveBody } from './shared/bodyResolution'
import { applyBodyOperation } from './bodyOps'
import { applyBodyPattern, resolvePatternSourceBody, type BodyPatternResult } from './patternBody'
import { resolveDirectionQueryStrict, resolveAxisQueryStrict } from './shared/directionQuery'
import { makeTranslationTrsf, makeRotationTrsf } from '../occ/transforms'
import {
  readSourceFaceRows, rebuildNamesForTransformedCopy, transformCopyWithMapping, type NameMaps,
} from '../occ/transformLineage'
import { emptyShapeNames, mergeShapeNames, readBodyNames } from '../occ/bodyNames'
import { booleanWithDiffMany, countSolids, shapesIntersect } from '../occ/booleans'
import { transferBooleanNames } from './booleanLineage'
import { resplitBody, solidHoldingFaces } from './bodySplit'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { markFeatureStart } from '../featureProgress'
import { resolveFeatureExpressions } from '../featureExpressions'
import { solveExtrude } from './extrude'
import { solveRevolve } from './revolve'
import { solveSweep } from './sweep'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import { stripRefSigil } from '@/utils/refSigil'
import { patternSubject } from '@/utils/core/patternSubject'

type Dict = Record<string, unknown>

interface PatternResult {
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

/**
 * Resolve a required linear direction, applying an invert toggle. An explicit
 * pick query wins. Without one, a stored vector is honoured as a unit world
 * vector: the schema accepted it but the leaf used to ignore it and report the
 * direction as missing. With neither, the solve fails rather than falling back
 * to a world axis, so a user cannot accidentally repeat geometry along an
 * arbitrary direction.
 */
export function resolvePatternDirection(
  query: string,
  stored: unknown,
  invert: boolean,
  field: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): number[] {
  let dir: number[]
  if (query) {
    const resolved = resolveDirectionQueryStrict(query, globalRepo, bodyStore)
    if (!resolved) {
      throw new Error(`pattern: ${field} query '${query}' did not resolve to a straight edge or planar face`)
    }
    dir = resolved
  } else {
    if (stored === undefined || stored === null) {
      throw new Error(`pattern: ${field} is required; pick a straight edge or planar face`)
    }
    if (!Array.isArray(stored) || stored.length !== 3 || !stored.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new Error(`pattern: ${field} must be three finite numbers, got ${JSON.stringify(stored)}`)
    }
    const len = Math.hypot(stored[0], stored[1], stored[2])
    if (len < 1e-12) throw new Error(`pattern: ${field} must be a non-zero vector`)
    dir = (stored as number[]).map((c) => c / len)
  }
  // `c === 0 ? 0 : -c` keeps the negated zero components as +0, not -0.
  return invert ? dir.map((c) => (c === 0 ? 0 : -c)) : dir
}

/** A stored VEC3 field, or null when absent; a malformed value is a solve error. */
function storedVec3(value: unknown, key: string): number[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length !== 3 || !value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`pattern: ${key} must be three finite numbers, got ${JSON.stringify(value)}`)
  }
  return value as number[]
}

/**
 * A rotation axis, with the same precedence transform uses for its rotation: an
 * `axis` pick wins; else the stored `axis_origin` / `axis_direction` pair, where
 * a direction alone rotates about the world origin and an origin alone uses +Z
 * (transform's rule, so one default holds for both). Neither is a solve error
 * rather than a silent rotation about a world axis.
 */
export function resolvePatternAxis(
  axisQuery: string,
  originValue: unknown,
  directionValue: unknown,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  // The pick can be a straight edge, circular edge, sketch line, sketch
  // circle, cylindrical face, or planar face.
  if (axisQuery) {
    const axis = resolveAxisQueryStrict(axisQuery, globalRepo, bodyStore)
    if (!axis) throw new Error(`pattern: axis query '${axisQuery}' did not resolve to a usable axis`)
    return axis
  }
  const origin = storedVec3(originValue, 'axis_origin')
  const direction = storedVec3(directionValue, 'axis_direction')
  if (origin === null && direction === null) {
    throw new Error(
      'pattern: axis is required; pick an edge, sketch entity, or face as `axis`, ' +
        'or store the pair `axis_origin` + `axis_direction`',
    )
  }
  const dir = direction ?? [0, 0, 1]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-12) throw new Error('pattern: axis_direction must be a non-zero vector')
  return [origin ?? [0, 0, 0], dir.map((c) => c / len)]
}

function countOf(sub: Dict, fallback: number): number {
  const count = Number(sub.count ?? fallback)
  // Number.isInteger rejects NaN, Infinity and fractional values in one check,
  // so a hand-edited 2.7 throws instead of silently truncating to 2.
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`pattern: count must be a positive integer, got ${sub.count}`)
  }
  return count
}

function positiveInteger(value: unknown, key: string, fallback: number): number {
  const count = Number(value ?? fallback)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`pattern: ${key} must be a positive integer, got ${value}`)
  }
  return count
}

function finite(value: unknown, key: string, fallback: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n)) throw new Error(`pattern: ${key} must be a finite number, got ${value}`)
  return n
}

/**
 * One transform per copy. The subject's own slot is instance 0, so `includeSource`
 * decides whether the count includes it. A feature subject always includes the
 * source (its own application already happened), so it passes true; a body
 * subject passes its `include_source`.
 */
export function buildPatternTransforms(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  includeSource = true,
): OccTrsf[] {
  const mode = (sub.mode as string) ?? 'linear'

  if (mode === 'linear') {
    const count = countOf(sub, 2)
    const pitch = finite(sub.pitch, 'pitch', 20)
    const dir = resolvePatternDirection(
      (sub.direction_query as string) ?? '',
      sub.direction,
      (sub.invert as boolean) ?? false,
      'direction',
      globalRepo,
      bodyStore,
    )
    const copies = includeSource ? count - 1 : count
    const trsfs: OccTrsf[] = []
    for (let i = 1; i <= copies; i++) {
      trsfs.push(makeTranslationTrsf(oc, scope, dir[0] * pitch * i, dir[1] * pitch * i, dir[2] * pitch * i))
    }
    return trsfs
  }

  if (mode === 'rectangular') {
    const countX = positiveInteger(sub.count_x, 'count_x', 2)
    const countY = positiveInteger(sub.count_y, 'count_y', 2)
    const pitchX = finite(sub.pitch_x, 'pitch_x', 20)
    const pitchY = finite(sub.pitch_y, 'pitch_y', 20)
    const dirX = resolvePatternDirection(
      (sub.direction_x_query as string) ?? '', sub.direction_x, (sub.invert_x as boolean) ?? false,
      'direction X', globalRepo, bodyStore,
    )
    const dirY = resolvePatternDirection(
      (sub.direction_y_query as string) ?? '', sub.direction_y, (sub.invert_y as boolean) ?? false,
      'direction Y', globalRepo, bodyStore,
    )
    const trsfs: OccTrsf[] = []
    for (let j = 0; j < countY; j++) {
      for (let i = 0; i < countX; i++) {
        // The seed cell (0,0) is the source slot, never a copy, whether or not
        // the source is included. Linear and circular already exclude it.
        if (i === 0 && j === 0) continue
        trsfs.push(
          makeTranslationTrsf(
            oc,
            scope,
            dirX[0] * pitchX * i + dirY[0] * pitchY * j,
            dirX[1] * pitchX * i + dirY[1] * pitchY * j,
            dirX[2] * pitchX * i + dirY[2] * pitchY * j,
          ),
        )
      }
    }
    return trsfs
  }

  if (mode === 'circular') {
    const count = countOf(sub, 4)
    const stepRaw = sub.step_angle
    const step = stepRaw === undefined || stepRaw === null ? 360.0 / count : Number(stepRaw)
    if (!Number.isFinite(step)) {
      throw new Error(`pattern: step_angle must be a finite number, got ${sub.step_angle}`)
    }
    const [origin, resolvedDirection] = resolvePatternAxis(
      (sub.axis as string) ?? '',
      sub.axis_origin,
      sub.axis_direction,
      globalRepo,
      bodyStore,
    )
    // Invert flips the axis direction, which reverses the sweep sense.
    const invert = (sub.invert_axis as boolean) ?? false
    const axisDirection = invert ? resolvedDirection.map((c) => (c === 0 ? 0 : -c)) : resolvedDirection
    const trsfs: OccTrsf[] = []
    if (includeSource) {
      // Source occupies the seed (0-degree) slot; sweep from step.
      for (let i = 1; i < count; i++) {
        trsfs.push(makeRotationTrsf(oc, scope, origin, axisDirection, ((step * i) * Math.PI) / 180))
      }
    } else {
      // No source slot; sweep from the first step, never the seed. A sweep that
      // lands back on the seed (a full 360 wrap) drops that last copy, matching
      // the linear exclude behaviour of no copy at the source position.
      const wraps = step !== 0 && Math.abs((step * count) % 360) < 1e-9
      const n = wraps ? count - 1 : count
      for (let i = 1; i <= n; i++) {
        trsfs.push(makeRotationTrsf(oc, scope, origin, axisDirection, ((step * i) * Math.PI) / 180))
      }
    }
    return trsfs
  }

  throw new Error(`pattern: unknown mode '${mode}'`)
}

/**
 * The earlier feature a feature-subject pattern repeats, with its expressions
 * resolved the way its own solve resolved them. A feature that is suppressed,
 * later in the log than this pattern, or not a solid producer is refused by
 * name: each has a one-step fix, and none may silently pattern nothing.
 */
function resolveSource(
  patternFeatureId: string,
  ref: string,
  featuresById: Record<string, Dict>,
  variables: Record<string, number>,
  laterVariables: Record<string, number>,
): { id: string; kind: ToolKind; feature: Dict } {
  if (!ref) {
    throw new Error('pattern: source_feature is required; pick the feature to repeat')
  }
  const sourceId = stripRefSigil(ref, '@')
  const source = featuresById[sourceId]
  if (source === undefined) {
    throw new Error(`pattern: source feature '${sourceId}' does not exist`)
  }
  const order = Object.keys(featuresById)
  const patternAt = order.indexOf(patternFeatureId)
  if (patternAt >= 0 && order.indexOf(sourceId) > patternAt) {
    throw new Error(
      `pattern: the source feature '${sourceId}' comes after this pattern; move it up with ` +
        `reorder_features {featureId: '${sourceId}', before: '${patternFeatureId}'}`,
    )
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
  return { id: sourceId, kind, feature }
}

/**
 * The body a feature-subject pattern already shaped. An authored target wins.
 * Without one, the candidates are the bodies the source created or modified;
 * one is the answer, none and several are refusals that name the fix rather than
 * picking a body by store order.
 */
function resolvePatternTarget(
  sourceId: string,
  explicitRef: string,
  bodyStore: Record<string, Body>,
): Body {
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

/** One transformed tool copy: the shape and the identities it was minted with. */
interface CopyInstance {
  copy: number
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

/**
 * Solve a feature-subject pattern. The source feature's operation is applied
 * `count - 1` more times, each with the source's tool rigidly transformed.
 * Copies that refuse are named: some applied and some not is a `partial`
 * result, none applied is an error, so a half-applied pattern never reads as
 * complete.
 */
function solveFeaturePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
): PatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.pattern as Dict) ?? {}
  const source = resolveSource(
    featureId,
    (sub.source_feature as string) ?? '',
    featuresById,
    solveContext.variables,
    solveContext.laterVariables,
  )
  const sourceSub = (source.feature[source.kind] as Dict) ?? {}
  const operation = ((sourceSub.operation as string) ?? 'add') as 'add' | 'cut'
  const transforms = buildPatternTransforms(oc, scope, sub, globalRepo, bodyStore, true)
  const target = resolvePatternTarget(source.id, (sub.target_body as string) ?? '', bodyStore)
  const targetId = target.id

  // The source solved before this feature, so its own operation already sits in
  // the body; only the remaining instances are added here.
  if (transforms.length === 0) {
    return { status: 'ok', body_id: targetId, body_ids: [targetId], operation }
  }

  const scratch: Record<string, Body> = {}
  // A through_all cut sizes its tool from the bodies its copies will cut, which
  // is this solve's real store rather than the empty scratch one. The forced
  // `new` is only how the tool is handed back, so the cut-only rule judges the
  // source's own operation. Keep the source's merge_target so its own narrowing
  // still applies; `new` ignores that key when it registers the tool.
  const throughAllSource = source.kind === 'extrude' && (sourceSub.termination as string) === 'through_all'
    ? { operation, bodies: bodyStore }
    : undefined
  const toolSub: Dict = { ...sourceSub, operation: 'new' }
  if (throughAllSource === undefined) delete toolSub.merge_target
  const toolFeature: Dict = { ...source.feature, id: source.id, [source.kind]: toolSub }
  const tools: Body[] = []
  try {
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
    tools.push(...Object.values(scratch))
    if (tools.length === 0) {
      throw new Error(`pattern: the source feature '${source.id}' produced no solid to repeat`)
    }

    // Read once per tool, not per instance: the tool shape does not change
    // between copies.
    const toolShapes: Array<{ shape: OccShape; rows: ReturnType<typeof readSourceFaceRows> }> = []
    for (const body of tools) {
      const shape = table.get<OccShape>(body.shape!)
      const names = readBodyNames(oc, scope, shape, body)
      toolShapes.push({
        shape,
        rows: readSourceFaceRows(oc, scope, shape, names.faceNames, names.faceAncestry, names.capAncestry),
      })
    }

    const total = transforms.length
    const failures: string[] = []
    const notes: string[] = []
    let instance = 0
    // Every copy is built before the first boolean. The batch below fuses or
    // cuts the whole hit set in one operation, which is where the per-copy
    // quadratic went: one history, one name transfer, one resplit.
    const copies: CopyInstance[] = []
    for (let copy = 1; copy <= total; copy++) {
      markFeatureStart(featureId)
      for (const tool of toolShapes) {
        const { shape: rawShape, builder } = transformCopyWithMapping(oc, scope, tool.shape, transforms[copy - 1])
        const shape = scope.track(rawShape)
        copies.push({
          copy,
          shape,
          names: rebuildNamesForTransformedCopy(oc, scope, shape, tool.rows, featureId, instance, builder),
        })
        instance++
      }
    }

    // A missed cut leaves the solid count unchanged, so a probe is the only
    // reliable miss signal before the batch. Add copies are never misses: a
    // disjoint one is a regular island, and the batch fallback below lets the
    // per-copy path mint it.
    let selected = copies
    if (operation === 'cut') {
      const targetShape = table.get<OccShape>(target.shape!)
      const hits: CopyInstance[] = []
      for (const [copyNo, group] of groupByCopy(copies)) {
        const overlapping = group.filter((copy) => shapesIntersect(oc, targetShape, copy.shape))
        if (overlapping.length === 0) {
          failures.push(`copy ${copyNo}: cut does not intersect any target body - nothing to remove`)
        } else {
          hits.push(...overlapping)
        }
      }
      selected = hits
    }

    // The old per-copy path, kept for the two shapes a batch cannot report per
    // copy: a copy that consumes the target, and a union that leaves islands.
    const applyIndividually = (): PatternResult => {
      let appliedCopies = 0
      const live = new Set<string>([targetId])
      let consumed = false
      for (const [copyNo, group] of groupByCopy(selected)) {
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
            })
            copyApplied = true
            const ids = result.body_ids ?? (result.body_id ? [result.body_id] : [])
            if (ids.length === 0) {
              // The copy consumed the whole target: nothing keeps the id and no
              // later copy has a body to land on.
              live.delete(targetId)
              consumed = true
              notes.push(`pattern: copy ${copyNo} removed all of body '${targetId}'; later copies were not applied`)
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
            failures.push(`copy ${copyNo}: ${reason}`)
          }
        }
        if (copyApplied) appliedCopies++
      }
      if (appliedCopies === 0) {
        throw new Error(`pattern: no copy was applied; ${failures[0] ?? 'nothing to apply'}`)
      }
      const liveIds = [...live]
      const result: PatternResult = {
        status: failures.length > 0 ? 'partial' : 'ok',
        body_id: liveIds[0] ?? targetId,
        body_ids: liveIds,
        operation,
      }
      if (failures.length > 0) {
        result.exception = `pattern: ${appliedCopies}/${total} copies applied; ${failures.join('; ')}`
      }
      if (notes.length > 0) result.solver_warning = notes.join('; ')
      return result
    }

    if (selected.length === 0) {
      throw new Error(`pattern: no copy was applied; ${failures[0] ?? 'nothing to apply'}`)
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
        { unifyFaces: !target.imported },
      )
    } catch (e) {
      swallowUnlessTrap(e)
      return applyIndividually()
    }
    const newShape = scope.track(batched.shape)
    const oldSolids = countSolids(oc, scope, targetShape)
    const newSolids = countSolids(oc, scope, newShape)
    if (newSolids === 0 || newSolids > oldSolids) return applyIndividually()

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
    )
    target.modified_by.push(featureId)
    target.brep_diff = batched.diff
    if (brepDiffIsEmpty(batched.diff)) notes.push('pattern: operation produced no geometry change')

    const appliedCopies = groupByCopy(selected).size
    const result: PatternResult = {
      status: failures.length > 0 ? 'partial' : 'ok',
      body_id: bodyIds[0] ?? targetId,
      body_ids: bodyIds,
      operation,
    }
    if (failures.length > 0) {
      result.exception = `pattern: ${appliedCopies}/${total} copies applied; ${failures.join('; ')}`
    }
    if (notes.length > 0) result.solver_warning = notes.join('; ')
    return result
  } finally {
    // Every scratch body the forced `new` solve registered, including any made
    // before a throw: they are this leaf's transient tool, never part rows.
    releaseScratch(table, Object.values(scratch))
  }
}

/**
 * Solve a pattern of either subject. A body pattern copies a body through the
 * grid; a feature pattern reapplies an earlier feature's own add or cut.
 */
export function solvePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | BodyPatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.pattern as Dict) ?? {}
  // A document authored before the subject field is read from the source it
  // actually names. The editor and the boolean leaf share this one rule, so an
  // old feature pattern is not silently edited or expanded as a body pattern.
  const subject = patternSubject(sub)

  if (subject === 'body') {
    const body = resolvePatternSourceBody(sub, bodyStore)
    const includeSource = (sub.include_source as boolean) ?? true
    const operation = (sub.operation as string) ?? 'add'
    const transforms = buildPatternTransforms(oc, scope, sub, globalRepo, bodyStore, includeSource)
    return applyBodyPattern(oc, scope, table, body, transforms, includeSource, operation, featureId, bodyStore)
  }

  if (subject === 'feature') {
    return solveFeaturePattern(oc, scope, table, feature, globalRepo, bodyStore, featuresById, solveContext)
  }

  throw new Error(`pattern: unknown subject '${subject}'; choose body or feature`)
}
