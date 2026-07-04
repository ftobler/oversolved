// [step-hang-debug] Temporary runtime switch for the imported-STEP + extrude
// rebuild hang. Default OFF, so a clean build behaves unchanged.
//
// Enable WITHOUT a rebuild: open DevTools, switch the console context to the
// solver Worker (Sources tab > the thread/target picker > solverWorker), run
//     __STEP_DEBUG__ = true
// then reproduce the extrude. The switch is read live on every solve, so the
// trace turns on for the very next rebuild. Set it back to false (or reload) to
// silence it. Remove this module and its call sites once the stall is located.

export function stepDebug(): boolean {
  return (globalThis as unknown as { __STEP_DEBUG__?: boolean }).__STEP_DEBUG__ === true
}
