// @vitest-environment node
//
// The session fuzz's real-kernel half, shard 3: a separate file so vitest runs
// it in its own fork beside the others (see fuzzShards.ts). Idle unless
// FUZZ_SHARDS is 4.
import { describeRealFuzzShard } from './fuzzRealShard'

await describeRealFuzzShard(3)
