// Shared test fixtures with no React or DOM dependency, so both the browser
// and the node-environment kernel suites can import them.
import type { Transform3D } from '@/types/cad'

/** The unit rigid transform: no translation, identity rotation. */
export function identity(): Transform3D {
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** A promise plus its external settle function, used to hold an async save
 *  open while a test drives an edit through the window. */
export function deferred<T = boolean>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
