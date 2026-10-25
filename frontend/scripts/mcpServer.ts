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
import { KernelFault } from '@/kernel/errors'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { PartDoc } from '@/types/cad'
import { createHeadlessPart } from '@/drive/headlessPart'
import { runHeadless, measureHeadless, compareHeadless, exportHeadless, selectHeadless, emptyDriveDoc } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createDriveJournal } from '@/drive/journal'
import { createMcpServer, type McpCadOps, type McpFileRef } from '@/drive/mcpServer'
import { DocHandleStore } from '@/drive/docHandleStore'
import { resolveDoc, runReply } from '@/drive/mcpDocRef'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'
import type { ScriptStep } from '@/drive/scriptRunner'
import { parseReference } from '@/translations/corpus'
import { routeKernelStdoutToStderr } from './kernelStdout'
import { readProjectReference, resolveProjectPath, writeDocFile } from './docPath'

// The headless OCC loader and the nodejs solver builds; without them the solve
// reports the kernel unavailable instead of a document.
setOccLoader(loadOcc, resetOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

// stdout is the protocol channel, so the kernel's own prints must not land
// there: the OCC STEP writer prints a transfer banner on stdout (Module.print
// goes to console.log), which would corrupt the stream. Responses go through
// the saved writer; every other stdout write is forwarded to stderr.
const writeProtocol = routeKernelStdoutToStderr()

function emptyPartDoc(): PartDoc {
  return emptyDriveDoc()
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

  documentText: (docHash) => {
    const doc = documents.get(docHash)
    return doc === undefined ? null : JSON.stringify(doc)
  },

  async commands() {
    // A fresh seeded session supplies the live enabled verdicts; reading the
    // catalog runs no spec body and starts no solve.
    const part = createHeadlessPart({ doc: emptyPartDoc(), docId: 'mcp-commands' })
    return { ok: true, commands: commandCatalog(PART_COMMAND_SPECS, id => part.registry.enabled(id)) }
  },

  async run(req) {
    // Resolve the write path before the script runs: an unsafe path must be
    // refused without doing the work the caller expected to save.
    let out: string | undefined
    if (req.out !== undefined) {
      try {
        out = resolveProjectPath(req.out, 'doc')
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
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
      ...(req.featureDeltas !== undefined && { featureDeltas: req.featureDeltas }),
    })
    const reply = runReply(result, req.returnDoc === true, documents)
    if (out === undefined || result.doc === null) return reply
    try {
      const written = writeDocFile(out, result.doc)
      return { ...reply, file: written.file, format: written.format }
    } catch (e) {
      return { ...reply, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async measure(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    let measure
    try {
      measure = await measureHeadless(resolved.doc, {
        docId: req.docId ?? 'mcp',
        files: readFiles(req.files),
      })
    } catch (e) {
      // A kernel fault is a failed tool call with a readable reason, not a
      // protocol error: the same distinction the other tool failures make.
      if (e instanceof KernelFault) return { ok: false, error: e.message }
      throw e
    }
    if (!measure) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return { ok: measure.ok, docHash: resolved.docHash, ...measure.measures, features: measure.features, frames: measure.frames }
  },

  async compare(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    let reference = req.reference
    if (reference === undefined) {
      if (req.referencePath === undefined) {
        return { ok: false, error: 'pass exactly one of "reference" or "referencePath"' }
      }
      try {
        const { file, text } = readProjectReference(req.referencePath)
        // The corpus parser, named by the reference's directory as the corpus
        // suite does, so a file-based reference is held to the same contract.
        reference = parseReference(path.basename(path.dirname(file)), text)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    const result = await compareHeadless(resolved.doc, reference, {
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
    // The same resolver and roots as run's `out`, checked before the export
    // runs: a relative path used to land under frontend/ and an unwritable one
    // surfaced as a raw JSON-RPC internal error (MCAD stepper F2).
    let out: string
    try {
      out = resolveProjectPath(req.out, 'doc')
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    let bytes
    try {
      bytes = await exportHeadless(resolved.doc, {
        format: req.format,
        bodyId: req.body ?? null,
        docId: req.docId ?? 'mcp',
        files: readFiles(req.files),
      })
    } catch (e) {
      if (e instanceof KernelFault) return { ok: false, error: e.message }
      throw e
    }
    if (!bytes) {
      return { ok: false, error: 'export produced no solid (or the local solver is unavailable)' }
    }
    try {
      writeFileSync(out, bytes)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
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
