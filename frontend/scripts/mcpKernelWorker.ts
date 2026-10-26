// The MCP server's kernel worker thread (src/drive/kernelWorker.ts serves it).
// The server spawns it through src/drive/kernelHost.ts and kills it when a
// solve stalls, so a kernel operation that never returns costs one call.
//
// OVERSOLVED_MCP_TEST_HANG_FEATURE=<featureId> is a test hook: the worker
// spins forever when its build reaches that feature, the stand-in for a kernel
// operation that never returns (cliSmoke.test.ts drives the stall path with
// it). Nothing in production sets it.

import { parentPort } from 'node:worker_threads'
import { onFeatureStart } from '@/kernel/featureProgress'
import { bootHeadlessKernel, serveKernel, type KernelPort } from '@/drive/kernelWorker'

if (!parentPort) throw new Error('mcpKernelWorker must run as a worker thread')

bootHeadlessKernel()
serveKernel(parentPort as unknown as KernelPort)

const hangFeature = process.env.OVERSOLVED_MCP_TEST_HANG_FEATURE
if (hangFeature) {
  // Subscribed after serveKernel, so the progress mark naming the feature is
  // already posted when the spin starts, as it is before a real stuck feature.
  onFeatureStart((featureId) => {
    if (featureId !== hangFeature) return
    for (;;) {
      // A busy loop with no exit: only Worker.terminate() ends it.
    }
  })
}
