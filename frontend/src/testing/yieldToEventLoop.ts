/**
 * Hand the event loop one macrotask turn.
 *
 * The real kernel (OCC + the Rust solvers) is synchronous WASM behind `async`
 * signatures, so a loop of builds awaits only already-settled promises and
 * never leaves the microtask queue. Inside a vitest fork that starves the
 * worker's RPC channel: the reply to its `onTaskUpdate` call sits unread, and
 * once the loop has been held for 60 s (birpc's fixed timeout, not
 * configurable) the run dies with an unattributed `Timeout calling
 * "onTaskUpdate"` even though every test passed. `src/test-setup.ts` watches
 * for the stall; long build loops call this between builds to avoid it.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}
