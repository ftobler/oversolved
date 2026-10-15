// The bounded seed scheduler for the chain sweep: `run` over seeds 0..count-1
// with at most `workers` in flight, results slotted by seed, so the aggregation
// that follows is byte-identical at any width. The sweep's determinism contract
// is exactly that: same seeds, same findings, same order, whatever the pool.

export async function runSeedsBounded<T>(
  count: number,
  workers: number,
  run: (seed: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T | undefined>(count)
  let next = 0
  const pull = async (): Promise<void> => {
    for (;;) {
      const seed = next++
      if (seed >= count) return
      results[seed] = await run(seed)
    }
  }
  const width = Math.max(1, Math.min(Math.floor(workers), count))
  await Promise.all(Array.from({ length: width }, () => pull()))
  return results as T[]
}
