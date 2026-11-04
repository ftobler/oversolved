// The `detail` switch on assembly run, measure and export replies. The kernel
// always builds the full state; this module trims it on the host so a one-field
// edit does not repeat every pose and mate frame the caller already holds. Pure:
// no kernel, no document store.

import type { AssemblyDoc } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type { AssemblyPartProblem, InstancePose, MateFrame, MateProblem } from '@/drive/assemblyOutcome'
import { mateFeatures } from '@/utils/assemblyMutations'
import { round } from '@/utils/yamlMutations/helpers'

export const ASSEMBLY_DETAILS = ['summary', 'changed', 'full'] as const
export type AssemblyDetail = typeof ASSEMBLY_DETAILS[number]

/** The default stays `full` for one release so existing callers keep today's
 *  reply; the switch to `changed` is a recorded backlog decision. */
export const DEFAULT_ASSEMBLY_DETAIL: AssemblyDetail = 'full'

export interface AssemblyDetailState {
  solve: AssemblySolveStatus
  mates: MateProblem[]
  parts: AssemblyPartProblem[]
  instances: InstancePose[]
  mateFrames: Record<string, MateFrame>
  summary: string
}

export interface AssemblyDetailContext {
  // The document the call started from; null when it started fresh or the
  // caller measures a document with no earlier version.
  inputDoc: AssemblyDoc | null
  // The input document's solved poses; null when there is nothing to compare.
  baseline: InstancePose[] | null
}

type ShapedState = Partial<Omit<AssemblyDetailState, 'solve'>> & { solve: unknown; summary: string }

function samePose(a: InstancePose, b: InstancePose): boolean {
  const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => round(v) === round(y[i]!))
  return a.fixed === b.fixed && a.part === b.part && same(a.position, b.position) && same(a.quaternion, b.quaternion)
}

/** The instances that are new or whose solved pose differs from the baseline at
 *  the document's 6-decimal rounding. With no baseline nothing can be called
 *  moved, so none are listed. */
export function movedInstances(
  instances: readonly InstancePose[],
  baseline: readonly InstancePose[] | null,
): InstancePose[] {
  if (baseline === null) return []
  const before = new Map(baseline.map(pose => [pose.handle, pose]))
  return instances.filter((pose) => {
    const prior = before.get(pose.handle)
    return prior === undefined || !samePose(pose, prior)
  })
}

/** Mate ids this call added or edited, by comparing the mate features of the
 *  input and the final document. Without an input every mate counts as new. */
export function touchedMateIds(input: AssemblyDoc | null, output: AssemblyDoc): Set<string> {
  const before = new Map(
    input === null ? [] : mateFeatures(input).map(({ id, mate }) => [id, JSON.stringify(mate)] as const),
  )
  const touched = new Set<string>()
  for (const { id, mate } of mateFeatures(output)) {
    if (before.get(id) !== JSON.stringify(mate)) touched.add(id)
  }
  return touched
}

function solveSummary(solve: AssemblySolveStatus): unknown {
  const { mates: _mates, parts: _parts, ...rest } = solve
  return rest
}

function solveChanged(solve: AssemblySolveStatus, problems: readonly MateProblem[]): unknown {
  const ids = new Set(problems.map(problem => problem.id))
  const mates = Object.fromEntries(Object.entries(solve.mates).filter(([id]) => ids.has(id)))
  const parts = Object.fromEntries(Object.entries(solve.parts).filter(([, part]) => part.failed))
  return { ...solve, mates, parts }
}

/** Trim an assembly state to the requested detail. `full` returns it as is. */
export function shapeAssemblyState(
  state: AssemblyDetailState,
  detail: AssemblyDetail,
  output: AssemblyDoc,
  context: AssemblyDetailContext,
): ShapedState {
  if (detail === 'full') return state
  const base = { mates: state.mates, parts: state.parts, summary: state.summary }
  if (detail === 'summary') return { ...base, solve: solveSummary(state.solve) }
  const touched = touchedMateIds(context.inputDoc, output)
  const problemIds = new Set(state.mates.map(problem => problem.id))
  const mateFrames = Object.fromEntries(
    Object.entries(state.mateFrames).filter(([id]) => touched.has(id) || problemIds.has(id)),
  )
  return {
    ...base,
    solve: solveChanged(state.solve, state.mates),
    instances: movedInstances(state.instances, context.baseline),
    mateFrames,
  }
}

/** The assembly state an export reply repeats beside the file: no poses and no
 *  mate frames, because the product is the bytes. */
export interface AssemblyExportState {
  solve: AssemblySolveStatus
  mates: MateProblem[]
  parts: AssemblyPartProblem[]
  instances: InstancePose[]
  summary: string
}

type ShapedExport = Omit<AssemblyExportState, 'solve' | 'instances'> & { solve: unknown }

/**
 * Trim an export verdict. `summary` keeps the solve in its summary form, the
 * mate and part problem rows and the one-line summary. An export has no
 * starting document to diff against, so `changed` is treated as `summary`;
 * `full` keeps today's reply, poses included. This is deliberately not
 * `shapeAssemblyState`'s `changed` arm, which adds the moved poses and mate
 * frames an export does not carry.
 */
export function shapeAssemblyExport(
  state: AssemblyExportState,
  detail: AssemblyDetail,
): AssemblyExportState | ShapedExport {
  if (detail === 'full') return state
  const { instances: _instances, solve, ...rest } = state
  return { ...rest, solve: solveSummary(solve) }
}

/** Collapse accepted steps to a count; refused ones stay whole. */
export function shapeSteps<S extends { ok: boolean }>(
  steps: readonly S[],
  detail: AssemblyDetail,
): { steps: readonly S[] } | { stepsAccepted: number; steps?: S[] } {
  if (detail === 'full') return { steps }
  const refused = steps.filter(step => !step.ok)
  return { stepsAccepted: steps.length - refused.length, ...(refused.length > 0 && { steps: refused }) }
}

/**
 * Trim an assembly measure for a `detail` level. The per-body table is the
 * large part of a measure reply, so `summary` and `changed` keep the aggregate
 * record (bodies, volume, area, centroid, bbox and the topology counts) alone;
 * `full` keeps every body row.
 */
export function shapeAssemblyMeasures(
  measures: MeasureRecord,
  detail: AssemblyDetail,
): MeasureRecord | Omit<MeasureRecord, 'perBody'> {
  if (detail === 'full') return measures
  const { perBody: _perBody, ...aggregate } = measures
  return aggregate
}
