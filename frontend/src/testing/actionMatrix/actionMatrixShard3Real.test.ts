// @vitest-environment node
//
// The action-matrix real-kernel sweep, shard 3. See actionMatrixRealShard.ts.
import { describeRealActionMatrixShard } from './actionMatrixRealShard'

await describeRealActionMatrixShard(3)
