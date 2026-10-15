// Q6: the drive surface, the `window.__oversolved` bridge, exists in
// development and test builds only.
//
// The expression must be evaluated at module scope and referenced directly at
// the guarded site: Vite folds `import.meta.env.DEV` to `false` in a
// production build and the initializer becomes `false || "production" ===
// "test"`, which the minifier folds to `false`, dropping the bridge installer
// and `driveSurface.ts` (verified on `frontend/dist`: `__oversolved` does not
// appear). Routing the check through a function defeated that fold and kept
// the whole bridge in the bundle.
//
// The session journal sink is deliberately not gated: the part editor attaches
// it in every build, because the recovery autosave borrows its replayable
// tail, so `drive/journal.ts` and its `oversolved-repro` payload kind stay in
// the production bundle.
export const DRIVE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test'
