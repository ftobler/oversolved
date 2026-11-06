// @vitest-environment node
//
// The real session fuzz's shard split, checked without a kernel: every seed
// replays in exactly one shard, and every shard index FUZZ_SHARDS can name has
// a file that registers it. A missing or mis-numbered shard file would drop
// its slice of seeds while the sweep still reported green.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { SHARD_FILES, shardCount, shardSeeds } from './fuzzShards'

const DIR = join(process.cwd(), 'src/hooks/__tests__')

function shardFileName(shard: number): string {
  return shard === 0 ? 'fuzzReal.test.ts' : `fuzzShard${shard}Real.test.ts`
}

describe('the real session fuzz shard split', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('replays every seed in exactly one shard for every shard count', () => {
    for (const total of [0, 1, 4, 7, 200]) {
      for (let count = 1; count <= SHARD_FILES; count++) {
        const all = Array.from({ length: count }, (_, shard) => shardSeeds(total, shard, count)).flat()
        expect(all.sort((a, b) => a - b), `${total} seeds over ${count} shards`).toEqual(
          Array.from({ length: total }, (_, i) => i),
        )
      }
    }
  })

  it('balances the slices to within one seed', () => {
    const sizes = [0, 1, 2, 3].map(shard => shardSeeds(201, shard, 4).length)
    expect(sizes).toEqual([51, 50, 50, 50])
  })

  it('defaults to one shard and refuses more shards than files', () => {
    vi.stubEnv('FUZZ_SHARDS', '')
    expect(shardCount()).toBe(1)
    vi.stubEnv('FUZZ_SHARDS', String(SHARD_FILES))
    expect(shardCount()).toBe(SHARD_FILES)
    vi.stubEnv('FUZZ_SHARDS', String(SHARD_FILES + 1))
    expect(() => shardCount()).toThrow(/exceeds the 4 shard files/)
  })

  it('has one file per shard index, each registering its own index', () => {
    for (let shard = 0; shard < SHARD_FILES; shard++) {
      const text = readFileSync(join(DIR, shardFileName(shard)), 'utf8')
      expect(text, shardFileName(shard)).toContain(`await describeRealFuzzShard(${shard})`)
    }
  })

  it('lists every shard file in the fuzz-session recipe', () => {
    // The recipe names its files explicitly, so a shard file it forgets would
    // never run and its slice of seeds would vanish from a green sweep.
    const justfile = readFileSync(join(process.cwd(), '..', 'justfile'), 'utf8')
    const recipe = /^fuzz-session .*:\n((?: {4}.*\n)+)/m.exec(justfile)
    expect(recipe, 'fuzz-session recipe not found in the justfile').not.toBeNull()
    for (let shard = 0; shard < SHARD_FILES; shard++) {
      expect(recipe![1], shardFileName(shard)).toContain(`src/hooks/__tests__/${shardFileName(shard)}`)
    }
  })

  it('has no shard file beyond SHARD_FILES', () => {
    // A fifth file would stay idle forever, because shardCount refuses a
    // FUZZ_SHARDS above SHARD_FILES; the constant has to grow with the files.
    const extra = readdirSync(DIR).filter(name => {
      const match = /^fuzzShard(\d+)Real\.test\.ts$/.exec(name)
      return match !== null && Number(match[1]) >= SHARD_FILES
    })
    expect(extra).toEqual([])
  })
})
