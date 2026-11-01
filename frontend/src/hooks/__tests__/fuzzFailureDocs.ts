// Shared by the fake and real session-fuzz suites: a failing seed prints the
// document the session held at that step, not only a number, so the user can
// open the YAML in the app and reproduce the failure directly. The path is
// under the project's gitignored `tmp/`. A write failure is a warning, never a
// replacement for the real assertion message.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { FuzzRunResult } from './fuzzHarness'

export function reportFailureDocs(seed: number, result: FuzzRunResult): void {
  for (const { step, doc } of result.failureDocs) {
    const dir = join(process.cwd(), 'tmp', 'fuzz-session')
    const path = join(dir, `seed-${seed}-step-${step}.yaml`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, stringify(doc))
      console.error(`[fuzz] seed ${seed} step ${step}: openable document at ${path}`)
    } catch (error) {
      console.warn(`[fuzz] seed ${seed} step ${step}: could not write the repro to ${path}: ${String(error)}`)
    }
  }
}
