// The headless drive CLI: run scripts, measure and export documents, and
// replay repro journals through the real in-process kernel. Beside
// regenCorpus.ts and under the same --experimental-strip-types recipe (with
// driveCli.loader.mjs, which adds the import.meta.env shim the app sources
// need outside Vite).
//
// One session per process is the v1 contract: solveLocally's cross-solve
// checkpoint cache is single-writer module state, so two sessions would
// interleave their caches. Split into two processes instead.
//
// Usage:
//   npm run drive -- run <script.json> [--doc <file>] [--out <doc.yaml>] [--repro <file>]
//   npm run drive -- measure <doc.(yaml|json)>
//   npm run drive -- export <doc.(yaml|json)> --format step|stl [--out <file>] [--body <id>]
//   npm run drive -- replay <repro.json>
//
// Every command prints one JSON object on stdout; diagnostics go to stderr.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { measureLocally, exportLocally } from '@/kernel/solveLocally'
import type { PartDoc } from '@/types/cad'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { createHeadlessPart, partSolvePayload } from '@/drive/headlessPart'
import { CommandJournal, type ReproPayload } from '@/drive/journal'
import { docHashOf } from '@/drive/docHash'
import { replayJournal } from '@/drive/replay'
import { seededIdSource } from '@/drive/seededIds'
import { setIdSource } from '@/utils/yamlMutations'
import type { ScriptStep } from '@/drive/scriptRunner'

// ─── kernel bootstrap ───

// The headless OCC loader and the nodejs solver builds; without them
// solveLocally returns null and every solve reports "unavailable".
setOccLoader(loadOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

// ─── argument parsing ───

interface Args {
  command: string | undefined
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=')
      if (inline !== undefined) flags[name] = inline
      else {
        const next = rest[i + 1]
        if (next === undefined || next.startsWith('--')) flags[name] = 'true'
        else { flags[name] = next; i++ }
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

const USAGE = `usage: drive <run|measure|export|replay> [args] [--flags]
  run <script.(json|yaml)> [--doc <file>] [--out <doc.yaml>] [--repro <file>] [--doc-id <id>]
  measure <doc.(yaml|json)> [--doc-id <id>]
  export <doc.(yaml|json)> --format step|stl [--out <file>] [--body <id>]
  replay <repro.json>`

// ─── file helpers ───

function readYamlFile(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8'))
}

// The app seeds a fresh document with the builtin features (useDocumentState);
// the CLI mirrors that so commands that toggle plane/sketch visibility operate
// on the same document shape the browser does.
function seedBuiltins(doc: PartDoc): PartDoc {
  if (!Array.isArray(doc.features) || doc.features.length === 0) {
    doc.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
  }
  return doc
}

function readDoc(file: string): PartDoc {
  const parsed = readYamlFile(file)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a document object`)
  }
  return seedBuiltins(parsed as PartDoc)
}

function readSteps(file: string): ScriptStep[] {
  const parsed = readYamlFile(file)
  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown })?.steps
  if (!Array.isArray(steps)) throw new Error(`${file}: expected a steps array`)
  for (const [index, step] of steps.entries()) {
    if (typeof step !== 'object' || step === null) throw new Error(`${file}: step ${index} is not an object`)
    const record = step as Record<string, unknown>
    if (typeof record.command !== 'string' && typeof record.mutation !== 'object') {
      throw new Error(`${file}: step ${index} needs a command or a mutation`)
    }
  }
  return steps as ScriptStep[]
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

// ─── commands ───

async function runCommand(args: Args): Promise<number> {
  const scriptFile = args.positional[0]
  if (!scriptFile) throw new UsageError('run needs a script file')
  // Seeded before the first step: every id a mutation handler mints internally
  // (add_rect, add_ngon, constraint ids) is a pure function of the step
  // sequence, so two runs of one script build byte-identical documents and the
  // recorded repro replays exactly.
  setIdSource(seededIdSource())
  const steps = readSteps(scriptFile)
  const doc = args.flags.doc
    ? readDoc(args.flags.doc)
    : seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
  const journal = new CommandJournal()
  const part = createHeadlessPart({ doc, docId: args.flags['doc-id'] ?? 'cli', journal })
  const outcome = await part.run(steps)
  const finalDoc = part.getDoc()
  const solveState = part.solve.state()

  if (args.flags.out) {
    if (!finalDoc) throw new Error('run produced no document')
    writeFileSync(path.resolve(args.flags.out), stringifyYaml(finalDoc))
  }
  if (args.flags.repro) {
    const repro = journal.repro()
    if (!repro) throw new Error('run recorded no doc-changing command; nothing to reproduce')
    writeFileSync(path.resolve(args.flags.repro), JSON.stringify(repro, null, 1) + '\n')
  }

  printJson({
    ok: outcome.ok && solveState.lastError === null,
    steps: outcome.steps,
    docHash: finalDoc ? docHashOf(finalDoc) : null,
    solve: solveState,
  })
  return outcome.ok && solveState.lastError === null ? 0 : 1
}

async function measureCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  if (!file) throw new UsageError('measure needs a document file')
  const doc = readDoc(file)
  const payload = partSolvePayload(doc, args.flags['doc-id'] ?? 'cli')
  const measure = await measureLocally(payload)
  if (!measure) {
    printJson({ ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' })
    return 1
  }
  printJson({ ok: true, ...measure })
  return 0
}

async function exportCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  if (!file) throw new UsageError('export needs a document file')
  const format = args.flags.format
  if (format !== 'step' && format !== 'stl') throw new UsageError('export needs --format step|stl')
  const doc = readDoc(file)
  const payload = partSolvePayload(doc, args.flags['doc-id'] ?? 'cli')
  const bytes = await exportLocally(payload, {
    format,
    bodyId: args.flags.body ?? null,
  })
  if (!bytes) {
    printJson({ ok: false, error: 'export produced no solid (or the local solver is unavailable)' })
    return 1
  }
  const out = path.resolve(args.flags.out ?? `out.${format}`)
  writeFileSync(out, bytes)
  printJson({ ok: true, file: out, format, bytes: bytes.byteLength })
  return 0
}

async function replayCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  if (!file) throw new UsageError('replay needs a repro file')
  const repro = readYamlFile(file) as ReproPayload
  if (repro?.kind !== 'oversolved-repro' || !Array.isArray(repro.journal)) {
    throw new Error(`${file}: not an oversolved repro payload`)
  }
  // The replay installs its own fresh seeded source and applies the recorded
  // mutations to a session, hashing synchronously around each apply.
  const part = createHeadlessPart({ doc: repro.doc as PartDoc, docId: 'replay' })
  const outcome = await replayJournal(repro, part.session, () => part.idle())
  printJson(outcome)
  return outcome.ok ? 0 : 1
}

class UsageError extends Error {}

// ─── entry ───

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'run': return runCommand(args)
    case 'measure': return measureCommand(args)
    case 'export': return exportCommand(args)
    case 'replay': return replayCommand(args)
    default:
      console.error(USAGE)
      return 2
  }
}

main()
  .then(code => { process.exitCode = code })
  .catch((e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`drive: ${e.message}\n${USAGE}`)
      process.exitCode = 2
      return
    }
    printJson({ ok: false, error: e instanceof Error ? e.message : String(e) })
    process.exitCode = 1
  })
