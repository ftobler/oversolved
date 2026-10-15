// The MCP server entry: boots the headless kernel, wires the tool ops over the
// shared headless operations (the same ones the drive CLI uses) and runs the
// JSON-RPC stdio loop. Launch:
//
//   cd frontend && npm run mcp
//
// stdout carries protocol messages only; diagnostics go to stderr. Tool calls
// are processed one at a time by the readline loop, which is what keeps the
// process-wide kernel state single-writer even though every call builds a
// fresh document session (the same one-session-per-operation shape the CLI has
// per process).

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { PartDoc } from '@/types/cad'
import { createHeadlessPart } from '@/drive/headlessPart'
import { runHeadless, measureHeadless, exportHeadless, seedBuiltins } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createCliJournal } from '@/drive/journal'
import { createMcpServer, type McpCadOps, type McpFileRef } from '@/drive/mcpServer'
import type { ScriptStep } from '@/drive/scriptRunner'

// The headless OCC loader and the nodejs solver builds; without them the solve
// reports the kernel unavailable instead of a document.
setOccLoader(loadOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

// stdout is the protocol channel, so the kernel's own prints must not land
// there: the OCC STEP writer prints a transfer banner on stdout (Module.print
// goes to console.log), which would corrupt the stream. Responses go through
// the saved writer; every other stdout write is forwarded to stderr.
const writeProtocol = process.stdout.write.bind(process.stdout)

function redirectKernelOutput(): void {
  const toStderr = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: (err?: Error | null) => void,
  ): boolean => process.stderr.write(chunk as never, encoding as never, callback as never)
  process.stdout.write = toStderr as typeof process.stdout.write
  console.log = (...args: unknown[]) => { console.error(...args) }
}

function emptyPartDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

// Paths resolve against the server's cwd, like the CLI's --file values.
function readFiles(files: McpFileRef[]): ReadonlyMap<string, Uint8Array> | undefined {
  if (files.length === 0) return undefined
  const map = new Map<string, Uint8Array>()
  for (const file of files) map.set(file.id, new Uint8Array(readFileSync(path.resolve(file.path))))
  return map
}

const ops: McpCadOps = {
  async commands() {
    // A fresh seeded session supplies the live enabled verdicts; reading the
    // catalog runs no spec body and starts no solve.
    const part = createHeadlessPart({ doc: emptyPartDoc(), docId: 'mcp-commands' })
    return { ok: true, commands: commandCatalog(PART_COMMAND_SPECS, id => part.registry.enabled(id)) }
  },

  async run(req) {
    const doc = (req.doc as PartDoc | undefined) ?? emptyPartDoc()
    // The CLI journal pins the id seed, so a script mints the same ids on
    // every call and the returned document hashes repeat across runs.
    const result = await runHeadless({
      doc,
      steps: req.steps as ScriptStep[],
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
      journal: createCliJournal(),
    })
    return {
      ok: result.ok,
      steps: result.outcome.steps,
      docHash: result.docHash,
      solve: result.solve,
      doc: result.doc,
    }
  },

  async measure(req) {
    const measure = await measureHeadless(req.doc as PartDoc, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    if (!measure) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return { ok: true, ...measure }
  },

  async export(req) {
    const bytes = await exportHeadless(req.doc as PartDoc, {
      format: req.format,
      bodyId: req.body ?? null,
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    if (!bytes) {
      return { ok: false, error: 'export produced no solid (or the local solver is unavailable)' }
    }
    const out = path.resolve(req.out)
    writeFileSync(out, bytes)
    return { ok: true, file: out, format: req.format, bytes: bytes.byteLength }
  },
}

async function main(): Promise<void> {
  redirectKernelOutput()
  const server = createMcpServer(ops)
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    // Awaiting here is the serialization the kernel contract needs: the next
    // line is not read until the current tool call has finished.
    const response = await server.handleLine(line)
    if (response !== null) writeProtocol(response + '\n')
  }
}

main().catch((e: unknown) => {
  console.error(`oversolved-mcp: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
