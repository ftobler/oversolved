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
import { runHeadless, measureHeadless, compareHeadless, exportHeadless, selectHeadless, seedBuiltins } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createDriveJournal } from '@/drive/journal'
import { createMcpServer, type McpCadOps, type McpFileRef } from '@/drive/mcpServer'
import { DocHandleStore } from '@/drive/docHandleStore'
import { resolveDoc, runReply } from '@/drive/mcpDocRef'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'
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

// Paths resolve against the server's cwd, like the CLI's --file values.
function readFiles(files: McpFileRef[]): ReadonlyMap<string, Uint8Array> | undefined {
  if (files.length === 0) return undefined
  const map = new Map<string, Uint8Array>()
  for (const file of files) map.set(file.id, new Uint8Array(readFileSync(path.resolve(file.path))))
  return map
}

// The docHash chain: in-process, content-addressed and bounded, so a session
// of calls never re-sends the whole document. The protocol module parses the
// argument shape; the store lives here with the real ops.
const documents = new DocHandleStore()

const ops: McpCadOps = {
  partDocSchema: () => PART_DOC_SCHEMA_JSON,

  async commands() {
    // A fresh seeded session supplies the live enabled verdicts; reading the
    // catalog runs no spec body and starts no solve.
    const part = createHeadlessPart({ doc: emptyPartDoc(), docId: 'mcp-commands' })
    return { ok: true, commands: commandCatalog(PART_COMMAND_SPECS, id => part.registry.enabled(id)) }
  },

  async run(req) {
    let doc: PartDoc
    if (req.doc !== undefined || req.docHash !== undefined) {
      const resolved = resolveDoc(req, documents)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      doc = resolved.doc
    } else {
      doc = emptyPartDoc()
    }
    // The journal derives its id seed from the starting document, so a repeat
    // of the same document and script mints the same ids and hashes the same
    // document, while a call chained by docHash draws a fresh sequence.
    const result = await runHeadless({
      doc,
      steps: req.steps as ScriptStep[],
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
      journal: createDriveJournal(doc),
    })
    return runReply(result, req.returnDoc === true, documents)
  },

  async measure(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const measure = await measureHeadless(resolved.doc, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    if (!measure) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return { ok: true, docHash: resolved.docHash, ...measure.measures, features: measure.features }
  },

  async compare(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const result = await compareHeadless(resolved.doc, req.reference, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    return {
      ok: result.ok,
      docHash: resolved.docHash,
      pass: result.pass,
      rows: result.rows,
      measures: result.measures,
      ...(result.error !== undefined && { error: result.error }),
    }
  },

  async export(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const bytes = await exportHeadless(resolved.doc, {
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
    return { ok: true, docHash: resolved.docHash, file: out, format: req.format, bytes: bytes.byteLength }
  },

  async select(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    try {
      const result = await selectHeadless(resolved.doc, req.selector, {
        docId: req.docId ?? 'mcp',
        files: readFiles(req.files),
      })
      if (!result) {
        return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
      }
      return { ok: true, docHash: resolved.docHash, ...result }
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
