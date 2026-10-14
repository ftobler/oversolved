// Q6: the drive surface exists in development and test builds only. Vite folds
// this constant at build time, so the production bundle drops the installer
// call (and, with it, the whole bridge module) as dead code; the acceptance
// check greps the built bundle for `__oversolved` to prove it.
export const DRIVE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test'
