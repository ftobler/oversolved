// @vitest-environment node
//
// The session fuzz's real-kernel half, shard 1: a separate file so vitest runs
// it in its own fork beside shard 0 (see fuzzShards.ts). Idle unless
// FUZZ_SHARDS is at least 2.
import { describeRealFuzzShard } from './fuzzRealShard'

await describeRealFuzzShard(1)
