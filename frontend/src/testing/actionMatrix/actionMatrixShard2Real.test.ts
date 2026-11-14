// @vitest-environment node
//
// The action-matrix real-kernel sweep, shard 2. See actionMatrixRealShard.ts.
import { describeRealActionMatrixShard } from './actionMatrixRealShard'

await describeRealActionMatrixShard(2)
