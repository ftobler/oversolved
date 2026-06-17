// Post-build: stamp dist/runtime-config.js with the deployment backend mode.
// The app bundle is byte-identical for every deployment; only this one-line
// file differs. `npm run build` leaves the public/ default (http); the static
// deploy runs `node scripts/writeRuntimeConfig.mjs static` to flip it.
import { writeFileSync } from 'node:fs'

const mode = process.argv[2] === 'static' ? 'static' : 'http'
writeFileSync(
  new URL('../dist/runtime-config.js', import.meta.url),
  `window.__OVERSOLVED_BACKEND__ = ${JSON.stringify(mode)}\n`,
)
console.log(`dist/runtime-config.js -> ${mode}`)
