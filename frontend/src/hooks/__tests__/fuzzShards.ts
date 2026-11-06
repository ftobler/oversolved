// The seed split of the real session fuzz across vitest forks.
//
// Seeds are independent, but the solver's module state (solveLocally, OCC, the
// sketch solver) is per process and solveLocally refuses overlapping solves, so
// the sweep can only go wide across processes. Vitest parallelizes files, not
// the seeds inside one test, so the shards are separate test files
// (fuzzReal.test.ts is shard 0, fuzzShard<N>Real.test.ts the rest), each
// replaying its own slice through one shared driver (fuzzRealShard.ts). The
// fork pool in vitest.config.ts then runs as many at once as the host's cores
// and memory allow: each shard holds its own ~0.75 GB OCC kernel.
//
// This module stays kernel-free so the partition and the shard-file roster are
// checked on every checkout (fuzzShards.test.ts).
import { envInt } from '@/testing/__tests__/envInt'

/** The number of shard files on disk; FUZZ_SHARDS can use up to this many. */
export const SHARD_FILES = 4

/**
 * The active shard count, from FUZZ_SHARDS. The PR gate leaves it unset: one
 * shard replays every seed and the other files skip without loading a kernel.
 * A count above the files on disk would silently drop the seeds of the missing
 * shards, so it is refused instead.
 */
export function shardCount(): number {
  const count = envInt('FUZZ_SHARDS', 1)
  if (count > SHARD_FILES) {
    throw new Error(`FUZZ_SHARDS=${count} exceeds the ${SHARD_FILES} shard files; add fuzzShard<N>Real.test.ts files to go wider`)
  }
  return count
}

/**
 * The seeds of `shard` out of `count`, round robin over 0..total-1. Seed cost
 * varies with what the generator draws, so an interleaved split balances the
 * shards better than contiguous blocks, and seed N still means the same
 * sequence whatever the shard count.
 */
export function shardSeeds(total: number, shard: number, count: number): number[] {
  const seeds: number[] = []
  for (let seed = shard; seed < total; seed += count) seeds.push(seed)
  return seeds
}
