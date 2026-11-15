// The instance model every pattern kind shares: which instances a count and a
// Centered flag generate, how each one is keyed for construction naming, and
// which of them a Skip Instances list drops. Pure numbers and strings, so the
// editor hint, the drive and the kernel all decide through this one module and
// cannot drift apart.
//
// Instance 0 is the original and is never generated. A centered axis also
// generates the reverse side, so count 2 centered is 3 instances (2 copies).
// Generated order is ascending absolute index, positive before negative at
// equal magnitude, so copies near the source are fused first and the order is
// independent of the skip list.

import { MAX_ARRAY_COUNT } from '@/utils/core/arrayLimits'
import { canonicalSkip, skipEntryKey, type SkipEntry } from '@/utils/core/patternSkip'

/** A generated instance: a signed 1D index, or a `[column, row]` grid cell. */
export type InstanceIndex = number | readonly [number, number]

export interface PatternInstance {
  index: InstanceIndex
  // The stable naming key: `3`, `-1`, `2:-1`. A non-negative 1D index spells
  // the same decimal the old position-based naming produced, so an existing
  // 1D document keeps every copy UUID.
  key: string
}

export function instanceKey(index: InstanceIndex): string {
  return skipEntryKey(index)
}

/**
 * The count rule, as a message or null. Count 1 is legal and quiet: it keeps
 * only the original. Non-integers, values below 1 and values past the cap are
 * refused, because none of them has a generated list.
 */
export function patternCountProblem(count: unknown): string | null {
  const value = Number(count)
  if (!Number.isInteger(value) || value < 1) {
    return 'count must be a whole number of at least 1; 1 keeps only the original'
  }
  if (value > MAX_ARRAY_COUNT) return `count must be at most ${MAX_ARRAY_COUNT}, got ${value}`
  return null
}

/** The instances one 1D mode generates, the original excluded. */
export function instanceIndices(count: number, centered: boolean): number[] {
  if (!Number.isInteger(count) || count < 1) return []
  const out: number[] = []
  for (let i = 1; i < count; i++) {
    out.push(i)
    if (centered) out.push(-i)
  }
  return out
}

/** How many instances one axis generates, the original included. */
export function generatedCount(count: number, centered: boolean): number {
  return centered ? Math.max(0, 2 * count - 1) : Math.max(0, count)
}

/** The offsets one rectangular axis generates, the seed 0 included. The seed
 *  row/column is the original's own line, so a 1 x N row is legal. */
export function axisOffsets(count: number, centered: boolean): number[] {
  if (!Number.isInteger(count) || count < 1) return []
  const out = [0]
  for (let i = 1; i < count; i++) {
    out.push(i)
    if (centered) out.push(-i)
  }
  return out
}

/** The cells a rectangular mode generates, the seed (0, 0) excluded. Row-major
 *  with the column fastest, the order the fuse and the body ids have always
 *  used. */
export function rectangularIndices(
  countX: number,
  countY: number,
  centeredX: boolean,
  centeredY: boolean,
): InstanceIndex[] {
  const xs = axisOffsets(countX, centeredX)
  const ys = axisOffsets(countY, centeredY)
  const out: InstanceIndex[] = []
  for (const j of ys) {
    for (const i of xs) {
      if (i === 0 && j === 0) continue
      out.push([i, j])
    }
  }
  return out
}

/** The cap one pattern's generated total (before skips) is held to. Centering
 *  can nearly double a count, so the check is on what is generated rather than
 *  on the authored value. */
export function instanceTotalProblem(total: number): string | null {
  if (total <= MAX_ARRAY_COUNT) return null
  return `the pattern would generate ${total} instances; the limit is ${MAX_ARRAY_COUNT}`
}

export function toInstances(indices: readonly InstanceIndex[]): PatternInstance[] {
  return indices.map((index) => ({ index, key: instanceKey(index) }))
}

export interface SkipFilter {
  kept: PatternInstance[]
  // Entries the current count and Centered setting do not generate. Not an
  // error: the user may lower the count and raise it again.
  stale: SkipEntry[]
}

/** The keys one skip entry matches. A row-0 cell is keyed `i:j` on a grid but
 *  an author may spell it `i`, so both spellings address it; one-dimensional
 *  instances only ever carry the bare spelling. */
function skipKeys(entry: number | readonly [number, number]): string[] {
  const key = skipEntryKey(entry)
  if (typeof entry === 'number') return [key, `${entry}:0`]
  return entry[1] === 0 ? [key, String(entry[0])] : [key]
}

/** Drop the skipped instances, keeping the generated order. */
export function filterSkippedInstances(instances: readonly PatternInstance[], skip: readonly SkipEntry[]): SkipFilter {
  const entries = canonicalSkip(skip)
  if (entries.length === 0) return { kept: [...instances], stale: [] }
  const wanted = new Map<string, SkipEntry>()
  for (const entry of entries) for (const key of skipKeys(entry)) wanted.set(key, entry)
  const keys = new Set(instances.map((instance) => instance.key))
  const kept = instances.filter((instance) => !wanted.has(instance.key))
  const stale = entries.filter((entry) => !skipKeys(entry).some((key) => keys.has(key)))
  return { kept, stale }
}

/** The visible warning a stale skip entry earns: it says the part still builds
 *  so the user does not read it as a refusal. */
export function staleSkipWarnings(stale: readonly SkipEntry[], setting: string): string[] {
  return stale.map((entry) => `skip lists instance ${skipEntryKey(entry)}, which ${setting} does not generate`)
}

/**
 * The coincidence rule for a circular pattern with an explicit step: a step
 * that lands one index on another modulo a full turn would stack two copies.
 * The seed is instance 0; the check runs on the placements' angles (within
 * 1e-6 deg), not on geometry. Null when every kept placement is distinct.
 */
export function circularCoincidentRefusal(
  indices: readonly InstanceIndex[],
  stepDeg: number,
): string | null {
  const placed: { index: number; angle: number }[] = [{ index: 0, angle: 0 }]
  const norm = (deg: number): number => ((deg % 360) + 360) % 360
  for (const raw of indices) {
    const index = typeof raw === 'number' ? raw : raw[0]
    const angle = norm(index * stepDeg)
    for (const earlier of placed) {
      const delta = Math.abs(angle - earlier.angle)
      const wrapped = Math.min(delta, Math.abs(360 - delta))
      if (wrapped < 1e-6) {
        return `pattern: instance ${index} lands on instance ${earlier.index} (step ${stepDeg} deg); ` +
          'lower the count or change the angle'
      }
    }
    placed.push({ index, angle })
  }
  return null
}

/** The editor hint: the live instance total the count, Centered and skip list
 *  add up to. `generated` is the list before skipping, so the hint and the
 *  kernel read one list. */
export function instanceSummary(generated: readonly PatternInstance[], skipped: number): string {
  const total = generated.length + 1
  const parts = [`${total} instance${total === 1 ? '' : 's'}`, `${generated.length - skipped} new`]
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return parts.join(', ')
}
