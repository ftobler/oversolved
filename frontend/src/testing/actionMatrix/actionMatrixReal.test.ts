// @vitest-environment node
//
// The action matrix against the real kernel: the same rows as the fake-suite
// smoke gate, replayed through solveLocally so every command's mutation goes
// through the actual OCC + Rust pipeline. A command's status cannot depend on
// the scheduler (it is decided by the registry and the session result), so the
// same committed baseline compares both ways; a kernel crash surfaces as a
// thrown solve error, not a row.
//
// With ACTION_MATRIX_FULL=1 this file also replays the whole corpus sweep
// (`just action-matrix`, the main gate): the real kernel where installed, the
// fake scheduler otherwise, always compared exactly against the baseline so a
// vanished row or a new command fails rather than being silently skipped.
//
// Shard 0 of the real-kernel sweep; the driver and the reasons for the split
// are in actionMatrixRealShard.ts and actionMatrixShards.ts.
import { describeRealActionMatrixShard } from './actionMatrixRealShard'

await describeRealActionMatrixShard(0)
