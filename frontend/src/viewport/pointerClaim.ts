/**
 * The pointers a press has taken away from the camera.
 *
 * A handle press owns its whole gesture. The store's drag gate says the same
 * thing, but only after React commits, which is too late: the browser can
 * deliver a pointermove before the commit, and on touch a one-finger press is
 * also a camera gesture. The claim is written synchronously in the press
 * handler and read by the camera on every move, so listener order and React
 * scheduling cannot let the same finger orbit.
 *
 * Framework-free and per viewport: part and assembly each create one, so a
 * handle in one pane can never freeze the other pane's camera.
 */
export interface PointerClaims {
  claim(pointerId: number): void
  release(pointerId: number): void
  isClaimed(pointerId: number): boolean
  anyClaimed(): boolean
  clear(): void
}

export function createPointerClaims(): PointerClaims {
  const claimed = new Set<number>()
  return {
    claim(pointerId: number): void {
      claimed.add(pointerId)
    },
    release(pointerId: number): void {
      claimed.delete(pointerId)
    },
    isClaimed(pointerId: number): boolean {
      return claimed.has(pointerId)
    },
    anyClaimed(): boolean {
      return claimed.size > 0
    },
    clear(): void {
      claimed.clear()
    },
  }
}
