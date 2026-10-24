// The headless drive CLI: run scripts, list the command registry, measure and
// export documents, and replay repro journals through the real in-process
// kernel. Beside regenCorpus.ts and under the same --experimental-strip-types
// recipe (with driveCli.loader.mjs, which adds the import.meta.env shim the
// app sources need outside Vite). The operations themselves live in
// src/drive/headlessOps.ts, shared with the MCP server so the two surfaces
// cannot drift.
//
// One session per process is the v1 contract: solveLocally's cross-solve
// checkpoint cache is single-writer module state, so two sessions would
// interleave their caches. Split into two processes instead.
//
// Usage:
//   npm run drive -- run <script.json> [--doc <file>] [--out <doc.(yaml|json)>] [--repro <file>]
//                     [--file <id>=<path>] [--doc-id <id>]
//   npm run drive -- commands
//   npm run drive -- measure <doc.(yaml|json)> [--file <id>=<path>]
//   npm run drive -- compare <doc.(yaml|json)> <reference.json> [--file <id>=<path>] [--doc-id <id>]
//   npm run drive -- export <doc.(yaml|json)> --format step|stl [--out <file>] [--body <id>] [--file <id>=<path>]
//   npm run drive -- replay <repro.json>
//
// --file supplies the bytes for an import_step feature's file_id (repeatable).
// --out for run chooses JSON by a .json extension and YAML otherwise; the path
// must resolve inside the project's tmp/ or bugreports/.
// Every command prints one JSON object on stdout; diagnostics go to stderr.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { PartDoc } from '@/types/cad'
import { docLoadErrorMessage, loadPartDoc } from '@/persistence/docSchema'
import { createHeadlessPart } from '@/drive/headlessPart'
import { runHeadless, measureHeadless, compareHeadless, exportHeadless, seedBuiltins } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createDriveJournal, type ReproPayload } from '@/drive/journal'
import { replayJournal } from '@/drive/replay'
import { parseReference } from '@/translations/corpus'
import type { ScriptStep } from '@/drive/scriptRunner'
import { routeKernelStdoutToStderr } from './kernelStdout'
import { resolveProjectPath, writeDocFile } from './docPath'

// ─── kernel bootstrap ───

// The headless OCC loader and the nodejs solver builds; without them
// solveLocally returns null and every solve reports "unavailable".
setOccLoader(loadOcc, resetOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

// The kernel's own prints (the OCC STEP writer's transfer banner) must not
// land on stdout: printJson writes through the saved writer, and everything
// else is forwarded to stderr.
const writeStdout = routeKernelStdoutToStderr()

// ─── argument parsing ───

interface Args {
  command: string | undefined
  positional: string[]
  // Last value wins per flag, as before; `repeated` keeps every value so a
  // flag like --file can appear once per imported file.
  flags: Record<string, string>
  repeated: Record<string, string[]>
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const repeated: Record<string, string[]> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      // The first '=' splits name from value, so a value may carry '=' (a
      // --file value is itself id=path).
      const eq = arg.indexOf('=')
      let name: string
      let value: string
      if (eq >= 2) {
        name = arg.slice(2, eq)
        value = arg.slice(eq + 1)
      } else {
        name = arg.slice(2)
        const next = rest[i + 1]
        if (next === undefined || next.startsWith('--')) value = 'true'
        else { value = next; i++ }
      }
      flags[name] = value
      ;(repeated[name] ??= []).push(value)
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags, repeated }
}

const USAGE = `usage: drive <run|commands|measure|compare|export|replay> [args] [--flags]
  run <script.(json|yaml)> [--doc <file>] [--out <doc.(yaml|json)>] [--repro <file>] [--file <id>=<path>] [--doc-id <id>]
  commands
  measure <doc.(yaml|json)> [--file <id>=<path>] [--doc-id <id>]
  compare <doc.(yaml|json)> <reference.json> [--file <id>=<path>] [--doc-id <id>]
  export <doc.(yaml|json)> --format step|stl [--out <file>] [--body <id>] [--file <id>=<path>]
  replay <repro.json>
--out for run writes JSON for a .json path and YAML otherwise, inside tmp/ or bugreports/.`

// ─── file helpers ───

function readYamlFile(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8'))
}

function readDoc(file: string): PartDoc {
  const parsed = readYamlFile(file)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a document object`)
  }
  // The same loader the app reads through: a legacy shape is healed and a
  // document the app would refuse fails here by field instead of reaching the
  // kernel half-parsed.
  const loaded = loadPartDoc(parsed, { name: file })
  if (!loaded.ok) throw new Error(docLoadErrorMessage(loaded.error))
  return seedBuiltins(loaded.doc)
}

function readSteps(file: string): ScriptStep[] {
  const parsed = readYamlFile(file)
  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown })?.steps
  if (!Array.isArray(steps)) throw new Error(`${file}: expected a steps array`)
  for (const [index, step] of steps.entries()) {
    if (typeof step !== 'object' || step === null) throw new Error(`${file}: step ${index} is not an object`)
    const record = step as Record<string, unknown>
    // typeof null is 'object', so the mutation arm needs the explicit check:
    // a null mutation must fail here with the step named, not as a TypeError
    // deep inside the runner (where the catch block reads mutation.type).
    if (typeof record.command !== 'string' && (typeof record.mutation !== 'object' || record.mutation === null)) {
      throw new Error(`${file}: step ${index} needs a command or a mutation`)
    }
  }
  return steps as ScriptStep[]
}

function printJson(value: unknown): void {
  writeStdout(JSON.stringify(value) + '\n')
}

// The solve file map from repeated `--file <id>=<path>` flags: the bytes for
// an import_step feature's file_id, exactly what the browser's file registry
// hands the worker.
function readFiles(args: Args): ReadonlyMap<string, Uint8Array> | undefined {
  const entries = args.repeated.file ?? []
  if (entries.length === 0) return undefined
  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0 || eq === entry.length - 1) {
      throw new UsageError(`--file expects <id>=<path>, got "${entry}"`)
    }
    files.set(entry.slice(0, eq), new Uint8Array(readFileSync(path.resolve(entry.slice(eq + 1)))))
  }
  return files
}

// ─── commands ───

async function runCommand(args: Args): Promise<number> {
  const scriptFile = args.positional[0]
  if (!scriptFile) throw new UsageError('run needs a script file')
  // Resolve the output before the script runs: a path outside tmp/ or
  // bugreports/ must be refused without doing the work it would have saved.
  const out = args.flags.out === undefined ? null : resolveProjectPath(args.flags.out, 'doc')
  const steps = readSteps(scriptFile)
  const doc = args.flags.doc
    ? readDoc(args.flags.doc)
    : seedBuiltins({ version: 1, kind: 'part', features: [] })
  const journal = createDriveJournal(doc)
  const result = await runHeadless({
    doc,
    steps,
    docId: args.flags['doc-id'] ?? 'cli',
    files: readFiles(args),
    journal,
  })

  let saved: { file: string; format: string } | null = null
  if (out !== null) {
    if (!result.doc) throw new Error('run produced no document')
    saved = writeDocFile(out, result.doc)
  }
  if (args.flags.repro) {
    const repro = journal.repro()
    if (!repro) throw new Error('run recorded no doc-changing command; nothing to reproduce')
    writeFileSync(path.resolve(args.flags.repro), JSON.stringify(repro, null, 1) + '\n')
  }

  printJson({
    ok: result.ok,
    steps: result.outcome.steps,
    docHash: result.docHash,
    solve: result.solve,
    features: result.features,
    featureDeltas: result.featureDeltas,
    ...(saved !== null && { file: saved.file, format: saved.format }),
  })
  return result.ok ? 0 : 1
}

async function commandsCommand(): Promise<number> {
  // A fresh seeded session supplies the live enabled verdicts; reading the
  // catalog runs no spec body and starts no solve.
  const part = createHeadlessPart({
    doc: seedBuiltins({ version: 1, kind: 'part', features: [] }),
    docId: 'cli-commands',
  })
  printJson({
    ok: true,
    commands: commandCatalog(PART_COMMAND_SPECS, id => part.registry.enabled(id)),
  })
  return 0
}

async function measureCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  if (!file) throw new UsageError('measure needs a document file')
  const doc = readDoc(file)
  const measure = await measureHeadless(doc, {
    docId: args.flags['doc-id'] ?? 'cli',
    files: readFiles(args),
  })
  if (!measure) {
    printJson({ ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' })
    return 1
  }
  printJson({ ok: measure.ok, ...measure.measures, features: measure.features })
  return measure.ok ? 0 : 1
}

async function compareCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  const referenceFile = args.positional[1]
  if (!file) throw new UsageError('compare needs a document file')
  if (!referenceFile) throw new UsageError('compare needs a reference.json file')
  const doc = readDoc(file)
  // Name the parse errors by the case directory, as the corpus suite does.
  const referenceName = path.basename(path.dirname(path.resolve(referenceFile)))
  const reference = parseReference(referenceName, readFileSync(referenceFile, 'utf8'))
  const result = await compareHeadless(doc, reference, {
    docId: args.flags['doc-id'] ?? 'cli',
    files: readFiles(args),
  })
  printJson(result)
  if (!result.ok) return 1
  return result.pass ? 0 : 1
}

async function exportCommand(args: Args): Promise<number> {
  const file = args.positional[0]
  if (!file) throw new UsageError('export needs a document file')
  const format = args.flags.format
  if (format !== 'step' && format !== 'stl') throw new UsageError('export needs --format step|stl')
  const doc = readDoc(file)
  const bytes = await exportHeadless(doc, {
    format,
    bodyId: args.flags.body ?? null,
    docId: args.flags['doc-id'] ?? 'cli',
    files: readFiles(args),
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
  // mutations to a session, hashing synchronously around each apply. The
  // recorded baseline crosses the same loader as any stored document, so a
  // repro carrying a shape the app would refuse fails here by field.
  const baseline = loadPartDoc(repro.doc, { name: file })
  if (!baseline.ok) throw new Error(docLoadErrorMessage(baseline.error))
  const part = createHeadlessPart({ doc: baseline.doc, docId: 'replay' })
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
    case 'commands': return commandsCommand()
    case 'measure': return measureCommand(args)
    case 'compare': return compareCommand(args)
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
