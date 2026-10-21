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
import { runHeadless, measureHeadless, compareHeadless, exportHeadless, selectHeadless, seedBuiltins } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createCliJournal } from '@/drive/journal'
import { createMcpServer, type McpCadOps, type McpDocArguments, type McpFileRef } from '@/drive/mcpServer'
import { DocHandleStore, DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'
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

// The docHash chain: in-process, content-addressed and bounded, so a session
// of calls never re-sends the whole document. The protocol module parses the
// argument shape; the store lives here with the real ops.
const documents = new DocHandleStore()

type ResolvedDoc = { ok: true; doc: PartDoc; docHash: string } | { ok: false; error: string }

function resolveDoc(req: McpDocArguments): ResolvedDoc {
  if (req.docHash !== undefined) {
    const doc = documents.get(req.docHash)
    if (!doc) {
      return {
        ok: false,
        error: `unknown docHash (the server keeps the last ${DOC_HANDLE_CAPACITY} documents); pass doc instead`,
      }
    }
    return { ok: true, doc, docHash: req.docHash }
  }
  if (req.doc === undefined) return { ok: false, error: 'no document: pass doc or docHash' }
  const loaded = loadDocPayload(req.doc)
  if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
  return { ok: true, doc: loaded.doc, docHash: documents.put(loaded.doc) }
}

// The reply's one-line index of what the script built. Body ids are the
// part_style keys (the solve write-back reconciles one entry per body);
// feature ids and kinds come from the feature log.
function summarizeDoc(doc: PartDoc): string {
  const features = (doc.features ?? []).map(feature => `${feature.id} (${feature.kind})`)
  const bodies = Object.keys(doc.part_style ?? {})
  return `features: ${features.length > 0 ? features.join(', ') : 'none'}; `
    + `bodies: ${bodies.length > 0 ? bodies.join(', ') : 'none'}`
}

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
      const resolved = resolveDoc(req)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      doc = resolved.doc
    } else {
      doc = emptyPartDoc()
    }
    // The CLI journal pins the id seed, so a script mints the same ids on
    // every call and the returned document hashes repeat across runs.
    const result = await runHeadless({
      doc,
      steps: req.steps as ScriptStep[],
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
      journal: createCliJournal(),
    })
    const finalDoc = result.doc
    const docHash = finalDoc ? documents.put(finalDoc) : result.docHash
    return {
      ok: result.ok,
      steps: result.outcome.steps,
      docHash,
      solve: result.solve,
      ...(finalDoc && { summary: summarizeDoc(finalDoc) }),
      ...(req.returnDoc === true && finalDoc && { doc: finalDoc }),
    }
  },

  async measure(req) {
    const resolved = resolveDoc(req)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const measure = await measureHeadless(resolved.doc, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    if (!measure) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return { ok: true, ...measure }
  },

  async compare(req) {
    const resolved = resolveDoc(req)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const result = await compareHeadless(resolved.doc, req.reference, {
      docId: req.docId ?? 'mcp',
      files: readFiles(req.files),
    })
    return {
      ok: result.ok,
      pass: result.pass,
      rows: result.rows,
      measures: result.measures,
      ...(result.error !== undefined && { error: result.error }),
    }
  },

  async export(req) {
    const resolved = resolveDoc(req)
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
    return { ok: true, file: out, format: req.format, bytes: bytes.byteLength }
  },

  async select(req) {
    const resolved = resolveDoc(req)
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
