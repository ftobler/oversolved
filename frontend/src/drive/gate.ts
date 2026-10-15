// Q6: the drive surface exists in development and test builds only.
//
// The expression must be evaluated at module scope and referenced directly at
// every guarded site: Vite folds `import.meta.env.DEV` to `false` in a
// production build and the initializer becomes `false || "production" ===
// "test"`, which the minifier folds to `false`, dropping the bridge installer,
// the journal sink and both modules (verified on `frontend/dist`: neither
// `__oversolved` nor `oversolved-repro` appears). Routing the check through a
// function defeated that fold and kept the whole bridge in the bundle.
export const DRIVE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test'
