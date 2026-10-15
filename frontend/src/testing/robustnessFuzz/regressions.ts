// Where a minimised failing recipe lands. During a failing sweep the runner
// writes the minimal recipe next to the suite as a committed regression
// fixture; the minimiser's own test writes to the project tmp/ instead so a
// green run never leaves a file behind. The fixture lives here rather than in
// the reference oracle corpus (frontend/oracle/): that corpus holds part
// documents with closed-form expectations, and a fuzz recipe is a different
// shape replayed through the leaf solvers, not a document.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecipeStep } from './recipe'

export interface MinimalRecipeFile {
  seed: number
  violations: string[]
  steps: RecipeStep[]
}

/** Write `entry` as seed-<seed>-minimal.json under `dir`; returns the path. */
export function writeMinimalRecipe(dir: string, entry: MinimalRecipeFile): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `seed-${entry.seed}-minimal.json`)
  writeFileSync(file, JSON.stringify(entry, null, 2) + '\n')
  return file
}

/** The committed fixture directory for minimised failing recipes. */
export function defaultRegressionsDir(): string {
  return fileURLToPath(new URL('./regressions/', import.meta.url))
}
