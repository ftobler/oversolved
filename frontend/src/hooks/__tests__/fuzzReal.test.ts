// @vitest-environment node
//
// The session fuzz's real-kernel half, shard 0: the only active shard when
// FUZZ_SHARDS is unset (the PR gate). The driver and the reasons for the split
// are in fuzzRealShard.ts and fuzzShards.ts.
import { describeRealFuzzShard } from './fuzzRealShard'

await describeRealFuzzShard(0)
