// Deployment backend mode, read at boot by src/config/capabilities.ts before
// the app bundle evaluates. This default ships 'http' (Flask PDM backend); the
// static build overwrites dist/runtime-config.js with 'static' via
// scripts/writeRuntimeConfig.mjs. Kept out of the hashed bundle so a single app
// build serves every deployment -- only this one-line file differs. See
// `just build`.
window.__OVERSOLVED_BACKEND__ = 'http'
