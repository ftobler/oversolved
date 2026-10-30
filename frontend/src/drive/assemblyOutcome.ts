// The assembly reply's problem lists and pose maps, the twins of
// drive/featureOutcome.ts and drive/featureFrames.ts for the assembly side. The
// status words come from the solve and from utils/core/assemblyStatus.ts; this
// module never re-derives a verdict from a partial signal.

import type { AssemblyDoc, MateRef } from '@/types/cad'
import type { AssemblyBuildResponse, AssemblySolveStatus } from '@/kernel/solveAssembly'
import type { Transform3D } from '@/types/cad'
import { ASSEMBLY_BUILTIN_ANCHORS, ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { partInstances, mateFeatures } from '@/utils/assemblyMutations'
import { assemblyVerdict, mateFailure } from '@/utils/core/assemblyStatus'
import { MATE_KIND_LABELS } from '@/utils/mateKinds'
import { quatToEulerXyz } from '@/utils/transform3d'
import { round } from '@/utils/yamlMutations/helpers'
import type { FeatureProblem } from '@/drive/featureOutcome'

export type MateProblemStatus = 'stale' | 'error' | 'residual' | 'overconstrained' | 'not_converged'

export interface MateProblem {
  id: string
  kind: string
  status: MateProblemStatus
  // Present on a stale ref: which slot no longer resolves.
  staleRefs?: string[]
  message: string
}

export interface AssemblyPartProblem {
  docId: string
  docHash: string
  features: FeatureProblem[]
  error?: string
}

export interface InstancePose {
  handle: string
  part: string
  fixed: boolean
  // 6-decimal rounded, like the part reply's frames.
  position: number[]
  // Extrinsic XYZ degrees, the editor's RX/RY/RZ boxes.
  rotation: number[]
  quaternion: number[]
}

export interface MateFrameSide {
  kind: string
  point: number[]
  axis: number[]
}

/** One mate's posed anchors and its residual, so an agent can read which way an
 *  axis points before choosing `flip`. */
export interface MateFrame {
  ref_a?: MateFrameSide
  ref_b?: MateFrameSide
  residual?: number
}

function kindLabel(kind: string): string {
  return (MATE_KIND_LABELS as Record<string, string>)[kind] ?? kind
}

/**
 * The mates the solve reported a problem for, in mate-log order. A stale ref,
 * a solver error and a residual past MATE_RESIDUAL_TOL are rows; a clean mate is
 * absent. An overconstrained verdict adds the one wildcard row the verdict
 * itself describes.
 */
export function mateProblems(doc: AssemblyDoc, status: AssemblySolveStatus): MateProblem[] {
  const problems: MateProblem[] = []
  for (const { id, mate } of mateFeatures(doc)) {
    const result = status.mates[id]
    const mark = mateFailure(id, status, [mate.ref_a.part, mate.ref_b.part])
    if (!mark.failed) continue
    // The predicate owns "is this a problem"; the word below says which of the
    // three causes it is, from the same per-mate result it read.
    const word: MateProblemStatus = result?.error !== undefined
      ? 'error'
      : result?.stale === true ? 'stale' : 'residual'
    const message = word === 'stale'
      ? (result?.staleRefs?.join(', ') ?? mark.message)
      : (result?.error ?? mark.message)
    problems.push({
      id,
      kind: mate.kind,
      status: word,
      ...(result?.staleRefs !== undefined && { staleRefs: result.staleRefs }),
      message,
    })
  }
  const verdict = assemblyVerdict(status)
  if (verdict.verdict === 'overconstrained') {
    problems.push({ id: '*', kind: 'assembly', status: 'overconstrained', message: verdict.message })
  }
  if (verdict.verdict === 'not_converged') {
    problems.push({ id: '*', kind: 'assembly', status: 'not_converged', message: verdict.message })
  }
  return problems
}

/** The bound parts whose build reported problems, in binding order. */
export function partProblems(
  doc: AssemblyDoc,
  outcomes: Record<string, { features: FeatureProblem[]; error?: string }>,
  docHashes: ReadonlyMap<string, string>,
): AssemblyPartProblem[] {
  const seen = new Set<string>()
  const problems: AssemblyPartProblem[] = []
  for (const instance of partInstances(doc)) {
    const docId = instance.doc_id
    if (seen.has(docId)) continue
    seen.add(docId)
    const outcome = outcomes[docId]
    if (!outcome) continue
    if (outcome.features.length === 0 && outcome.error === undefined) continue
    problems.push({
      docId,
      docHash: docHashes.get(docId) ?? '',
      features: outcome.features,
      ...(outcome.error !== undefined && { error: outcome.error }),
    })
  }
  return problems
}

function quatOf(t: Transform3D): [number, number, number, number] {
  return [t.qx, t.qy, t.qz, t.qw]
}

/** Every instance's solved pose. The document keeps its authored seeds (D6),
 *  so this is the only place the solved placement is reported. */
export function instancePoses(doc: AssemblyDoc, transforms: Record<string, Transform3D>): InstancePose[] {
  return partInstances(doc).map((instance) => {
    const solved = transforms[instance.handle] ?? instance.transform
    const [rx, ry, rz] = quatToEulerXyz(quatOf(solved))
    return {
      handle: instance.handle,
      part: instance.doc_id,
      fixed: instance.fixed === true,
      position: [solved.tx, solved.ty, solved.tz].map(round),
      rotation: [(rx * 180) / Math.PI, (ry * 180) / Math.PI, (rz * 180) / Math.PI].map(round),
      quaternion: quatOf(solved).map(round),
    }
  })
}

function sideOf(ref: MateRef, response: AssemblyBuildResponse): MateFrameSide | undefined {
  const pose = ref.part === ASSEMBLY_HANDLE
    ? ASSEMBLY_BUILTIN_ANCHORS[ref.anchor]
    : response.anchors[ref.part]?.[ref.anchor]
  if (!pose) return undefined
  return {
    kind: pose.kind,
    point: pose.point.map(round),
    axis: pose.axis.map(round),
  }
}

/** Each mate's posed anchors from the solve, plus its residual when the solver
 *  produced one. */
export function mateFrames(doc: AssemblyDoc, response: AssemblyBuildResponse): Record<string, MateFrame> {
  const frames: Record<string, MateFrame> = {}
  for (const { id, mate } of mateFeatures(doc)) {
    const residual = response.status.mates[id]?.residual
    const a = sideOf(mate.ref_a, response)
    const b = sideOf(mate.ref_b, response)
    frames[id] = {
      ...(a !== undefined && { ref_a: a }),
      ...(b !== undefined && { ref_b: b }),
      ...(residual !== undefined && { residual }),
    }
  }
  return frames
}

/** The reply's one-line index: instances, mates, verdict and the problems. */
export function summarizeAssembly(
  doc: AssemblyDoc,
  status: AssemblySolveStatus,
  mates: readonly MateProblem[],
  parts: readonly AssemblyPartProblem[],
): string {
  const instances = partInstances(doc).map((instance) => {
    const flags = instance.fixed === true ? ', fixed' : ''
    return `${instance.handle} (${instance.doc_id}${flags})`
  })
  const mateList = mateFeatures(doc).map(({ id, mate }) => `${id} (${kindLabel(mate.kind)})`)
  const verdict = assemblyVerdict(status)
  const verdictText = verdict.verdict === 'none'
    ? 'none'
    : `${verdict.verdict}${verdict.verdict === 'underconstrained' ? ` (dof ${status.dof})` : ''}`
  const problems = [
    ...mates.map(problem => `${problem.id} (${problem.kind}) ${problem.status}: ${problem.message}`),
    ...parts.map(problem => `${problem.docId} (part) ${problem.error ?? 'problems'}`),
  ]
  return `instances: ${instances.join(', ') || 'none'}; `
    + `mates: ${mateList.join(', ') || 'none'}; `
    + `verdict: ${verdictText}`
    + (problems.length > 0 ? `; problems: ${problems.join('; ')}` : '')
}

/** Whether a final solve is a run failure. A mate problem, a part build problem
 *  and an overconstrained verdict are data; only a solver that did not run is a
 *  failed call (D12). */
export function solveFailed(status: AssemblySolveStatus): boolean {
  return status.verdict === 'failed' || status.verdict === 'unavailable'
}
