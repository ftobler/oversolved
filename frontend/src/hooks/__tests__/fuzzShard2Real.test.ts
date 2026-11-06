// @vitest-environment node
//
// The session fuzz's real-kernel half, shard 2: a separate file so vitest runs
// it in its own fork beside the others (see fuzzShards.ts). Idle unless
// FUZZ_SHARDS is at least 3.
import { describeRealFuzzShard } from './fuzzRealShard'

await describeRealFuzzShard(2)
