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
