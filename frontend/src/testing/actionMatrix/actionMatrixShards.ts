// The document split of the real action-matrix sweep across vitest forks.
//
// The corpus documents are independent, but the solver's module state
// (solveLocally, OCC, the sketch solver) is per process, and the matrix holds
// one kernel per fork, so the sweep can only go wide across processes. Vitest
// parallelizes files, not the documents inside one test, so the shards are
// separate test files (actionMatrixReal.test.ts is shard 0,
// actionMatrixShard<N>Real.test.ts the rest), each replaying its own slice
// through one shared driver (actionMatrixRealShard.ts). The fork pool in
// vitest.config.ts then runs as many at once as the host's cores and memory
// allow: each shard holds its own ~0.75 GB OCC kernel.
//
// This module stays kernel-free so the partition and the shard-file roster are
// checked on every checkout.


/** The number of shard files on disk; the active count can use up to this many. */
export const SHARD_FILES = 4

/**
 * The active shard count, from ACTION_MATRIX_SHARDS (or MATRIX_SHARDS). The PR
 * gate leaves it unset: one shard replays every document and the other files
 * skip without loading a kernel. A count above the files on disk would silently
 * drop the documents of the missing shards, so it is refused instead.
 */
export function shardCount(): number {
  const raw = process.env.ACTION_MATRIX_SHARDS ?? process.env.MATRIX_SHARDS ?? ''
  const parsed = Number.parseInt(raw, 10)
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  if (resolved > SHARD_FILES) {
    throw new Error(`shard count ${resolved} exceeds the ${SHARD_FILES} shard files; add actionMatrixShard<N>Real.test.ts files to go wider`)
  }
  return resolved
}

/**
 * The document indices of `shard` out of `count`, round robin over 0..total-1.
 * Document cost varies, so an interleaved split balances the shards better than
 * contiguous blocks, and document N still means the same entry whatever the
 * shard count.
 */
export function shardSeeds(total: number, shard: number, count: number): number[] {
  const out: number[] = []
  for (let i = shard; i < total; i += count) out.push(i)
  return out
}

// Aliases for callers/tests that name the partition by documents.
export const shardDocs = shardSeeds
export const shardIndices = shardSeeds


export { shardCount as matrixShardCount }
export { shardSeeds as matrixShardSeeds }
export { SHARD_FILES as MATRIX_SHARD_FILES }
