// Copy the wasm-pack `--target web` build into public/wasm so the dev server
// and production build serve it at /wasm/ for phase 1 shadow mode. Run via
// `npm run shadow:wasm` (which builds the crate first). Safe to re-run.

import { cp, mkdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../../sketch-solver/pkg')
const dest = path.resolve(here, '../public/wasm')

const FILES = [
  'sketch_solver.js',
  'sketch_solver_bg.wasm',
  'sketch_solver.d.ts',
  'sketch_solver_bg.wasm.d.ts',
]

try {
  await access(pkg)
} catch {
  console.error(`No web pkg at ${pkg}. Build it first:`)
  console.error('  cd ../sketch-solver && wasm-pack build --target web --out-dir pkg --release')
  process.exit(1)
}

await mkdir(dest, { recursive: true })
for (const f of FILES) {
  await cp(path.join(pkg, f), path.join(dest, f))
}
console.log(`Copied ${FILES.length} files to ${dest}`)
