// True when this module is executing inside a Web Worker rather than on the
// main thread. Workers expose WorkerGlobalScope on globalThis; the main thread
// does not. Used to gate worker-only bootstrap (message handlers, DOM-free
// loaders) so the same module can be imported from both contexts.
export function inWorker(): boolean {
  const g = globalThis as { WorkerGlobalScope?: unknown }
  return typeof g.WorkerGlobalScope !== 'undefined' && globalThis instanceof (g.WorkerGlobalScope as never)
}
