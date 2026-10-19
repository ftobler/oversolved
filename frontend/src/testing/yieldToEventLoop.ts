/**
 * Hand the event loop one macrotask turn.
 *
 * The real kernel (OCC + the Rust solvers) is synchronous WASM behind `async`
 * signatures, so a loop of builds awaits only already-settled promises and
 * never leaves the microtask queue. Inside a vitest fork that starves the
 * worker's RPC channel: the reply to its `onTaskUpdate` call sits unread, and
 * once the loop has been held for the worker RPC timeout the run dies with an
 * unattributed `Timeout calling "onTaskUpdate"` even though every test passed.
 * Vitest 3's 60 s is doubled to 120 s by scripts/vitestRpcTimeout.loader.mjs;
 * `src/test-setup.ts` watches for the stall, and long build loops call this
 * between builds to avoid it.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}
