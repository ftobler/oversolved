// Copy the wasm-pack `--target web` builds into public/wasm so the dev server
// and production build serve them at /wasm/. Two packages, one per solver crate
// (see src/wasm-kernel/solverWasm.ts for why they are split). Safe to re-run.

import { cp, mkdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const dest = path.resolve(here, '../public/wasm')

const PACKAGES = [
  { dir: 'sketch-solver', stem: 'sketch_solver' },
  { dir: 'mate-solver', stem: 'mate_solver' },
]

let copied = 0
for (const { dir, stem } of PACKAGES) {
  const pkg = path.resolve(here, `../../${dir}/pkg`)
  try {
    await access(pkg)
  } catch {
    console.error(`No web pkg at ${pkg}. Build it first:`)
    console.error(`  cd ../${dir} && wasm-pack build --target web --out-dir pkg --release`)
    console.error('  (or just: `just wasm`, which builds both crates and runs this script)')
    process.exit(1)
  }
  await mkdir(dest, { recursive: true })
  for (const f of [`${stem}.js`, `${stem}_bg.wasm`, `${stem}.d.ts`, `${stem}_bg.wasm.d.ts`]) {
    await cp(path.join(pkg, f), path.join(dest, f))
    copied++
  }
}
console.log(`Copied ${copied} files to ${dest}`)
