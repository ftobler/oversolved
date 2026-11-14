// @vitest-environment node
//
// The action-matrix real-kernel sweep, shard 1. See actionMatrixRealShard.ts.
import { describeRealActionMatrixShard } from './actionMatrixRealShard'

await describeRealActionMatrixShard(1)
