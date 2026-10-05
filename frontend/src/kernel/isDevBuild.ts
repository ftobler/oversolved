// True when the module runs under a dev build (vite sets env.DEV). Gates
// console chatter on hot paths so production solves stay silent; tests count
// as dev so diagnostics are visible while they run. Kept as one shared helper:
// handleTable and loadOccWeb each used to carry a private copy, which is what
// let an ungated console.log slip into solveLocally unnoticed.
export function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

/**
 * True in a dev build or under a test runner. The hot-path gates that replaced
 * their own `import.meta.env.DEV || import.meta.env.MODE === "test"` copies use
 * this: some test runners do not set `DEV`, so `isDevBuild()` alone would
 * silence diagnostics the tests rely on.
 */
export function isDevOrTestBuild(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean; MODE?: string } }).env
    return Boolean(env?.DEV) || env?.MODE === 'test'
  } catch {
    return false
  }
}
