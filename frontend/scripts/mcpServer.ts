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
import { docLoadErrorMessage, loadPartDoc } from '@/persistence/docSchema'
import { createHeadlessPart } from '@/drive/headlessPart'
import { runHeadless, measureHeadless, exportHeadless, selectHeadless, seedBuiltins } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createCliJournal } from '@/drive/journal'
import { createMcpServer, type McpCadOps, type McpFileRef } from '@/drive/mcpServer'
import type { ScriptStep } from '@/drive/scriptRunner'
import { routeKernelStdoutToStderr } from './kernelStdout'

// The headless OCC loader and the nodejs solver builds; without them the solve
// reports the kernel unavailable instead of a document.
setOccLoader(loadOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

// stdout is the protocol channel, so the kernel's own prints must not land
// there: the OCC STEP writer prints a transfer banner on stdout (Module.print
// goes to console.log), which would corrupt the stream. Responses go through
// the saved writer; every other stdout write is forwarded to stderr.
const writeProtocol = routeKernelStdoutToStderr()

function emptyPartDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] })
}

// A document arriving on the protocol crosses the same loader as one read from
// disk or the store, so an invalid payload comes back as an ok:false tool
// result naming the field instead of an internal error or a half-parsed spec.
function loadDocPayload(payload: unknown) {
  return loadPartDoc(payload, { name: 'mcp' })
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
    const loaded = req.doc === undefined ? null : loadDocPayload(req.doc)
    if (loaded && !loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
    const doc = loaded ? loaded.doc : emptyPartDoc()
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
    const loaded = loadDocPayload(req.doc)
    if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
    const measure = await measureHeadless(loaded.doc, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    if (!measure) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return { ok: true, ...measure }
  },

  async export(req) {
    const loaded = loadDocPayload(req.doc)
    if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
    const bytes = await exportHeadless(loaded.doc, {
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

  async select(req) {
    const loaded = loadDocPayload(req.doc)
    if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
    try {
      const result = await selectHeadless(loaded.doc, req.selector, {
        docId: req.docId ?? 'mcp',
        files: readFiles(req.files),
      })
      if (!result) {
        return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
      }
      return { ok: true, ...result }
    } catch (e) {
      // An empty match or a bad predicate expression is a tool failure, not a
      // protocol error: the message names the offending clause.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}

async function main(): Promise<void> {
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
