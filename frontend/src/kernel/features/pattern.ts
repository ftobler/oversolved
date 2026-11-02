// The pattern leaf: repeat an earlier solid-producing feature's own add or cut
// inside the body that feature already shaped. A body array plus a boolean can
// produce the same geometry, but it needs the material as its own body first and
// a merge afterwards; this feature asks the kernel for the source feature's tool
// once and applies that tool at each copy position through the same
// `applyBodyOperation` every producer uses.
//
// The source's tool is obtained by re-solving the source feature with its
// operation forced to `new` into a throwaway body store: the same leaf, the same
// profile resolution and the same names, with no second geometry builder. Those
// scratch bodies are released at the end of this solve; they never enter the
// real store, so no part row or checkpoint sees them.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousBodyRefError, resolveBody } from './shared/bodyResolution'
import { applyBodyOperation } from './bodyOps'
import { resolvePatternDirection, resolvePatternAxis } from './array'
import { makeTranslationTrsf, makeRotationTrsf } from '../occ/transforms'
import {
  readSourceFaceRows, rebuildNamesForTransformedCopy, transformCopyWithMapping,
} from '../occ/transformLineage'
import { readBodyNames } from '../occ/bodyNames'
import { resolveFeatureExpressions } from '../featureExpressions'
import { solveExtrude } from './extrude'
import { solveRevolve } from './revolve'
import { solveSweep } from './sweep'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import { stripRefSigil } from '@/utils/refSigil'

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
 * The earlier feature this pattern repeats, with its expressions resolved the
 * way its own solve resolved them. A feature that is suppressed, later in the
 * log than this pattern, or not a solid producer is refused by name: each has a
 * one-step fix, and none may silently pattern nothing.
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
        'a pattern repeats an extrude, revolve or sweep',
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
  if (kind === 'extrude' && (sub.termination as string) === 'up_to') {
    throw new Error(
      `pattern: the source feature '${sourceId}' terminates up_to, so its tool is trimmed once and the trim ` +
        'would travel with every copy; pattern a blind extrude instead',
    )
  }
  return { id: sourceId, kind, feature }
}

/**
 * The body the source feature already shaped. An authored target wins. Without
 * one, the candidates are the bodies the source created or modified; one is the
 * answer, none and several are refusals that name the fix rather than picking a
 * body by store order.
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

function countOf(sub: Dict): number {
  const count = Number(sub.count ?? 2)
  // Number.isInteger rejects NaN, Infinity and fractional values in one check,
  // so a hand-edited 2.7 throws instead of silently truncating to 2.
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`pattern: count must be a positive integer, got ${sub.count}`)
  }
  return count
}

/** One transform per copy. The source's own application is instance 0, so a
 *  count of 1 has nothing to copy and is an honest no-op. */
export function buildPatternTransforms(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): OccTrsf[] {
  const count = countOf(sub)
  if (count === 1) return []
  const mode = (sub.mode as string) ?? 'linear'
  if (mode === 'linear') {
    const pitch = Number(sub.pitch ?? 20)
    if (!Number.isFinite(pitch)) throw new Error(`pattern: pitch must be a finite number, got ${sub.pitch}`)
    const dir = resolvePatternDirection(
      (sub.direction_query as string) ?? '',
      sub.direction,
      (sub.invert as boolean) ?? false,
      'pattern',
      'direction',
      globalRepo,
      bodyStore,
    )
    const trsfs: OccTrsf[] = []
    for (let i = 1; i < count; i++) {
      trsfs.push(makeTranslationTrsf(oc, scope, dir[0] * pitch * i, dir[1] * pitch * i, dir[2] * pitch * i))
    }
    return trsfs
  }
  if (mode === 'circular') {
    const stepRaw = sub.step_angle
    const step = stepRaw === undefined || stepRaw === null ? 360.0 / count : Number(stepRaw)
    if (!Number.isFinite(step)) {
      throw new Error(`pattern: step_angle must be a finite number, got ${sub.step_angle}`)
    }
    const [origin, axis] = resolvePatternAxis(
      (sub.axis as string) ?? '',
      sub.axis_origin,
      sub.axis_direction,
      'pattern',
      globalRepo,
      bodyStore,
    )
    const invert = (sub.invert_axis as boolean) ?? false
    const direction = invert ? axis.map((c) => (c === 0 ? 0 : -c)) : axis
    const trsfs: OccTrsf[] = []
    for (let i = 1; i < count; i++) {
      trsfs.push(makeRotationTrsf(oc, scope, origin, direction, ((step * i) * Math.PI) / 180))
    }
    return trsfs
  }
  throw new Error(`pattern: unknown mode '${mode}'`)
}

/** Release the scratch bodies a forced `new` solve registered, and their shapes. */
function releaseScratch(table: HandleTable, tools: Body[]): void {
  for (const body of tools) {
    if (body.shape !== null && table.has(body.shape)) table.release(body.shape)
  }
}

/**
 * Solve the pattern. The source feature's operation is applied `count - 1` more
 * times, each with the source's tool rigidly transformed. Copies that refuse are
 * named: some applied and some not is a `partial` result, none applied is an
 * error, so a half-applied pattern never reads as complete.
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
  const transforms = buildPatternTransforms(oc, scope, sub, globalRepo, bodyStore)
  const target = resolvePatternTarget(source.id, (sub.target_body as string) ?? '', bodyStore)
  const targetId = target.id

  // The source solved before this feature, so its own operation already sits in
  // the body; only the remaining instances are added here.
  if (transforms.length === 0) {
    return { status: 'ok', body_id: targetId, body_ids: [targetId], operation }
  }

  const scratch: Record<string, Body> = {}
  const toolFeature: Dict = {
    ...source.feature,
    id: source.id,
    [source.kind]: { ...sourceSub, operation: 'new', merge_target: undefined },
  }
  delete (toolFeature[source.kind] as Dict).merge_target
  const tools: Body[] = []
  try {
    const built = TOOL_LEAVES[source.kind](oc, scope, table, toolFeature, globalRepo, scratch)
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
    // between copies (the same hoist the array leaf makes).
    const toolShapes: Array<{ shape: OccShape; rows: ReturnType<typeof readSourceFaceRows> }> = []
    for (const body of tools) {
      const shape = table.get<OccShape>(body.shape!)
      const names = readBodyNames(oc, scope, shape, body)
      toolShapes.push({
        shape,
        rows: readSourceFaceRows(oc, scope, shape, names.faceNames, names.faceAncestry, names.capAncestry),
      })
    }

    let appliedCopies = 0
    let instance = 0
    const failures: string[] = []
    const notes: string[] = []
    const live = new Set<string>([targetId])
    let consumed = false
    const total = transforms.length
    for (let copy = 0; copy < total && !consumed; copy++) {
      let copyApplied = false
      for (let toolIndex = 0; toolIndex < toolShapes.length; toolIndex++) {
        const tool = toolShapes[toolIndex]
        const { shape: rawShape, builder } = transformCopyWithMapping(oc, scope, tool.shape, transforms[copy])
        const shape = scope.track(rawShape)
        const names = rebuildNamesForTransformedCopy(oc, scope, shape, tool.rows, featureId, instance, builder)
        instance++
        try {
          const result = applyBodyOperation(oc, scope, table, {
            toolShape: shape,
            bodyStore,
            operation,
            mergeTarget: targetId,
            bodyId: 'body_' + featureId,
            featureId,
            sketchId: target.sketch_id,
            profileQueries: target.profile_queries,
            faceNames: names.faceNames,
            edgeNames: names.edgeNames,
            faceAncestry: names.faceAncestry,
            edgeAncestry: names.edgeAncestry,
            capAncestry: names.capAncestry,
            opName: 'pattern',
          })
          copyApplied = true
          const ids = result.body_ids ?? (result.body_id ? [result.body_id] : [])
          if (ids.length === 0) {
            // The copy consumed the whole target: nothing keeps the id and no
            // later copy has a body to land on.
            live.delete(targetId)
            consumed = true
            notes.push(`pattern: copy ${copy + 1} removed all of body '${targetId}'; later copies were not applied`)
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
          failures.push(`copy ${copy + 1}: ${reason}`)
        }
      }
      if (copyApplied) appliedCopies++
    }
    if (appliedCopies === 0) {
      throw new Error(`pattern: no copy was applied; ${failures[0] ?? 'nothing to apply'}`)
    }
    const soldIds = [...live]
    const result: PatternResult = {
      status: failures.length > 0 ? 'partial' : 'ok',
      body_id: soldIds[0] ?? targetId,
      body_ids: soldIds,
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
