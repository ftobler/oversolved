// Port of oversolved/kernel/query_heuristics.py. Heuristic scoring layer for the
// recursive ancestral query resolver. Resolution is three-valued: Resolved (one
// winner), Ambiguous (multiple plausible), Unresolved (none). All knobs live in
// HeuristicConfig (data, not magic numbers).

export const Outcome = {
  RESOLVED: "RESOLVED",
  AMBIGUOUS: "AMBIGUOUS",
  UNRESOLVED: "UNRESOLVED",
} as const

export type Outcome = (typeof Outcome)[keyof typeof Outcome]

export interface HeuristicConfig {
  // minimum fraction of old constituent-entity IDs that must appear in a new
  // candidate (0..1).
  overlapThreshold: number
  // per-ancestor-kind weights for scoring partial branches.
  kindWeights: Record<string, number>
  // relative-difference tolerance for geometry-leaf comparison.
  geometryLeafTolerance: number
  // ambiguity margin: top must beat runner-up by more than this to Resolve.
  ambiguityMargin: number
}

export const DEFAULT_HEURISTIC_CONFIG: HeuristicConfig = {
  overlapThreshold: 0.5,
  kindWeights: {},
  geometryLeafTolerance: 0.01,
  ambiguityMargin: 0.0,
}

export function weightFor(cfg: HeuristicConfig, kind: string): number {
  return cfg.kindWeights[kind] ?? 1.0
}

/** Fraction of oldIds present in newIds (0..1). */
export function scoreOverlap(oldIds: Set<string>, newIds: Set<string>): number {
  if (oldIds.size === 0) return 0.0
  let inter = 0
  for (const id of oldIds) if (newIds.has(id)) inter++
  return inter / oldIds.size
}

/**
 * Score how similar two geometry hints are: 1.0 (identical within tolerance) or
 * a fraction of matching shared keys. Null hints incur no penalty.
 */
export function scoreGeometryLeaf(
  oldGeom: Record<string, unknown> | null,
  newGeom: Record<string, unknown> | null,
  cfg: HeuristicConfig,
): number {
  if (oldGeom === null || newGeom === null) return 1.0
  const keys = Object.keys(oldGeom).filter(k => k in newGeom)
  if (keys.length === 0) return 0.0
  let matches = 0
  for (const k of keys) {
    const ov = oldGeom[k]
    const nv = newGeom[k]
    if (ov === null || ov === undefined || nv === null || nv === undefined) {
      if (ov === nv) matches++
      continue
    }
    if (typeof ov === "number" && typeof nv === "number") {
      if (Math.abs(ov) < 1e-12 && Math.abs(nv) < 1e-12) matches++
      else if (Math.abs(ov - nv) / Math.max(Math.abs(ov), 1e-12) <= cfg.geometryLeafTolerance) matches++
    } else if (ov === nv) {
      matches++
    }
  }
  return matches / keys.length
}

/**
 * Given scored candidates, return [outcome, winner]. The winner must beat the
 * runner-up by strictly more than cfg.ambiguityMargin to count as Resolved.
 */
export function pickBest<T>(
  scores: [T, number][],
  cfg: HeuristicConfig,
): [Outcome, T | null] {
  if (scores.length === 0) return [Outcome.UNRESOLVED, null]
  // stable sort by score descending (Array.sort is stable in modern engines,
  // matching Python's stable sorted()).
  const sorted = [...scores].sort((a, b) => b[1] - a[1])
  if (sorted.length === 1) return [Outcome.RESOLVED, sorted[0][0]]
  const topScore = sorted[0][1]
  const runnerUp = sorted[1][1]
  if (topScore - runnerUp > cfg.ambiguityMargin) return [Outcome.RESOLVED, sorted[0][0]]
  return [Outcome.AMBIGUOUS, null]
}
