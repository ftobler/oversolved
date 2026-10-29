// The MCP server entry: boots the headless kernel, wires the tool ops over the
// shared headless operations (the same ones the drive CLI uses) and runs the
// JSON-RPC stdio loop. Launch:
//
//   cd frontend && npm run mcp
//
// stdout carries protocol messages only; diagnostics go to stderr. Tool calls
// are processed one at a time by the readline loop. Every kernel call runs in
// the kernel worker thread (scripts/mcpKernelWorker.ts) behind
// src/drive/kernelHost.ts: a solve that stops announcing features for
// SOLVE_STALL_BUDGET_MS is killed and answered with a tool error naming the
// feature, and the next call gets a fresh worker (bug-fuse-hang). The worker
// keeps the kernel single-writer; documents and their docHash handles stay
// here, so a killed worker loses only its checkpoint cache.
//
// OVERSOLVED_MCP_SOLVE_BUDGET_MS overrides the stall budget (the stall test
// lowers it).

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Worker } from 'node:worker_threads'
import type { PartDoc } from '@/types/cad'
import { createHeadlessPart } from '@/drive/headlessPart'
import { emptyDriveDoc, type HeadlessMeasure, type HeadlessCompareResult, type HeadlessAssemblyMeasure, type HeadlessAssemblyCompare, type HeadlessAssemblyRunResult } from '@/drive/headlessOps'
import { commandCatalog } from '@/drive/commandCatalog'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { ASSEMBLY_COMMAND_SPECS } from '@/pages/assemblyCommandEntries'
import { createMcpServer, type McpCadOps, type McpFileRef } from '@/drive/mcpServer'
import { DocHandleStore } from '@/drive/docHandleStore'
import { assemblyRunReply, requirePartDoc, resolveAssemblyDoc, resolveDoc, runReply, type ResolvedDoc, type RunReplySource } from '@/drive/mcpDocRef'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'
import { ASSEMBLY_DOC_SCHEMA_JSON } from '@/persistence/assemblyDocSchema'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, type AssemblyScriptStep } from '@/drive/headlessAssembly'
import { buildAssemblyWorkspaceZip } from '@/drive/assemblyWorkspaceZip'
import { docHashOf } from '@/drive/docHash'
import type { ScriptStep } from '@/drive/scriptRunner'
import type { SelectResult } from '@/kernel/select'
import { parseReference } from '@/translations/corpus'
import { createKernelHost, isKernelCallFailure, type KernelOp, type KernelWorkerLike } from '@/drive/kernelHost'
import { routeKernelStdoutToStderr } from './kernelStdout'
import { readProjectReference, resolveProjectPath, writeDocFile } from './docPath'

function budgetFromEnv(): number | undefined {
  const raw = process.env.OVERSOLVED_MCP_SOLVE_BUDGET_MS
  if (raw === undefined) return undefined
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`OVERSOLVED_MCP_SOLVE_BUDGET_MS must be a positive number, got "${raw}"`)
  return ms
}

// The worker inherits this process's execArgv (the strip-types flag and the
// alias loader). Its stdout is piped to our stderr: the kernel prints (the OCC
// STEP writer's banner) must never reach the protocol channel.
const kernel = createKernelHost({
  budgetMs: budgetFromEnv(),
  factory: () => {
    const worker = new Worker(new URL('./mcpKernelWorker.ts', import.meta.url), { stdout: true })
    worker.stdout.pipe(process.stderr)
    return worker as unknown as KernelWorkerLike
  },
})

type KernelAnswer<T> = { ok: true; value: T } | { ok: false; error: string }

// The kernel's assembly run reply, minus the live session it cannot clone.
type AssemblyKernelResult = Omit<HeadlessAssemblyRunResult, 'session'>

// A timeout, a lost worker or a kernel fault is a failed tool call with a
// readable reason; anything else is a bug the server reports as internal.
async function callKernel<T>(op: KernelOp, args: unknown): Promise<KernelAnswer<T>> {
  try {
    return { ok: true, value: await kernel.call(op, args) as T }
  } catch (e) {
    if (isKernelCallFailure(e)) return { ok: false, error: e.message }
    throw e
  }
}

// stdout is the protocol channel, so stray prints must not land there (the
// kernel runs in the worker, whose stdout is piped to stderr above; this guards
// this thread): the OCC STEP writer prints a transfer banner on stdout (Module.print
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
  assemblyDocSchema: () => ASSEMBLY_DOC_SCHEMA_JSON,

  documentText: (docHash) => {
    const entry = documents.getEntry(docHash)
    if (entry === undefined) return null
    if (entry.kind === 'part') return JSON.stringify(entry.doc)
    const parts: Record<string, string> = {}
    for (const [docId, partDoc] of Object.entries(entry.parts)) parts[docId] = docHashOf(partDoc)
    return JSON.stringify({ kind: 'assembly', assembly: entry.doc, parts })
  },

  async commands(kind) {
    if (kind === 'assembly') {
      // A fresh session supplies the live enabled verdicts; the UI-only
      // commands report their refusal as the verdict string.
      const session = createHeadlessAssembly({ doc: emptyDriveAssemblyDoc(), parts: new Map() })
      return { ok: true, commands: commandCatalog(ASSEMBLY_COMMAND_SPECS, id => session.registry.enabled(id)) }
    }
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
    // A fresh document is the one case resolveDoc does not take: `run` may
    // start from nothing, and the kind chooses which seeded document.
    let resolved: ResolvedDoc
    if (req.doc === undefined && req.docHash === undefined) {
      // A fresh part run has no use for a binding; dropping it silently would
      // turn a forgotten `kind` into a plausible empty success.
      if (req.kind !== 'assembly' && req.parts !== undefined) {
        return { ok: false, error: 'field "parts" applies only to an assembly document' }
      }
      resolved = req.kind === 'assembly'
        ? resolveAssemblyDoc(emptyDriveAssemblyDoc(), req.parts, documents)
        : { ok: true, kind: 'part', doc: emptyPartDoc(), docHash: docHashOf(emptyPartDoc()) }
    } else {
      resolved = resolveDoc(req, documents)
    }
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const files = readFiles(req.files)

    if (resolved.kind === 'part') {
      if (out !== undefined && out.endsWith('.zip')) {
        return { ok: false, error: 'a workspace zip needs an assembly document; run the assembly instead' }
      }
      // The worker builds the drive journal from the starting document (its id
      // seed), as the in-process run did.
      const answer = await callKernel<RunReplySource>('run', {
        doc: resolved.doc,
        steps: req.steps as ScriptStep[],
        docId: req.docId ?? 'mcp',
        files,
        ...(req.featureDeltas !== undefined && { featureDeltas: req.featureDeltas }),
      })
      if (!answer.ok) return answer
      const result = answer.value
      const reply = runReply(result, req.returnDoc === true, documents)
      if (out === undefined || result.doc === null) return reply
      try {
        const written = writeDocFile(out, result.doc)
        return { ...reply, file: written.file, format: written.format }
      } catch (e) {
        return { ...reply, ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    if (req.featureDeltas !== undefined) {
      return { ok: false, error: 'featureDeltas applies only to part documents' }
    }
    const answer = await callKernel<AssemblyKernelResult>('assemblyRun', {
      doc: resolved.doc,
      parts: resolved.parts,
      steps: req.steps as AssemblyScriptStep[],
      files,
    })
    if (!answer.ok) return answer
    const result = answer.value
    const reply = assemblyRunReply({
      ok: result.ok,
      outcome: result.outcome,
      doc: result.doc,
      binding: resolved.parts,
      solve: result.solve,
      mates: result.mates,
      partProblems: result.parts,
      instances: result.instances,
      mateFrames: result.mateFrames,
      summary: result.summary,
    }, req.returnDoc === true, documents)
    if (out === undefined) return reply
    try {
      if (out.endsWith('.zip')) {
        const bytes = await buildAssemblyWorkspaceZip({
          doc: result.doc,
          parts: resolved.parts,
          ...(files !== undefined && { files }),
        })
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, bytes)
        return { ...reply, file: out, format: 'zip', bytes: bytes.byteLength }
      }
      const written = writeDocFile(out, result.doc)
      return { ...reply, file: written.file, format: written.format }
    } catch (e) {
      return { ...reply, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async measure(req) {
    const resolved = resolveDoc(req, documents)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const files = readFiles(req.files)
    if (resolved.kind === 'part') {
      const answer = await callKernel<HeadlessMeasure | null>('measure', {
        doc: resolved.doc,
        docId: req.docId ?? 'mcp',
        files,
      })
      if (!answer.ok) return answer
      const measure = answer.value
      if (!measure) {
        return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
      }
      return { ok: measure.ok, docHash: resolved.docHash, ...measure.measures, features: measure.features, frames: measure.frames }
    }
    const answer = await callKernel<HeadlessAssemblyMeasure | null>('assemblyMeasure', {
      doc: resolved.doc,
      parts: resolved.parts,
      files,
    })
    if (!answer.ok) return answer
    const measured = answer.value
    if (!measured) {
      return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
    }
    return {
      ok: measured.ok,
      kind: 'assembly',
      docHash: resolved.docHash,
      ...measured.measures,
      instances: measured.state.instances,
      solve: measured.state.solve,
      mates: measured.state.mates,
      parts: measured.state.parts,
    }
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
    const files = readFiles(req.files)
    if (resolved.kind === 'part') {
      const answer = await callKernel<HeadlessCompareResult>('compare', {
        doc: resolved.doc,
        reference,
        docId: req.docId ?? 'mcp',
        files,
      })
      if (!answer.ok) return answer
      const result = answer.value
      return {
        ok: result.ok,
        docHash: resolved.docHash,
        pass: result.pass,
        rows: result.rows,
        measures: result.measures,
        ...(result.error !== undefined && { error: result.error }),
      }
    }
    const answer = await callKernel<HeadlessAssemblyCompare>('assemblyCompare', {
      doc: resolved.doc,
      parts: resolved.parts,
      reference,
      files,
    })
    if (!answer.ok) return answer
    const result = answer.value
    return {
      ok: result.ok,
      kind: 'assembly',
      docHash: resolved.docHash,
      pass: result.pass,
      rows: result.rows,
      measures: result.measures,
      ...(result.state !== null && {
        instances: result.state.instances,
        solve: result.state.solve,
        mates: result.state.mates,
        parts: result.state.parts,
      }),
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
    const files = readFiles(req.files)
    let bytes: Uint8Array | null
    if (resolved.kind === 'part') {
      const answer = await callKernel<Uint8Array | null>('export', {
        doc: resolved.doc,
        format: req.format,
        bodyId: req.body ?? null,
        docId: req.docId ?? 'mcp',
        files,
      })
      if (!answer.ok) return answer
      bytes = answer.value
    } else {
      if (req.body !== undefined) {
        return { ok: false, error: 'per-instance export is not supported for an assembly; omit body' }
      }
      const answer = await callKernel<Uint8Array | null>('assemblyExport', {
        doc: resolved.doc,
        parts: resolved.parts,
        format: req.format,
        bodyId: null,
        files,
      })
      if (!answer.ok) return answer
      bytes = answer.value
    }
    if (!bytes) {
      return { ok: false, error: 'export produced no solid (or the local solver is unavailable)' }
    }
    try {
      // A fresh run directory may not exist yet, so make the parent at write time.
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, bytes)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, docHash: resolved.docHash, file: out, format: req.format, bytes: bytes.byteLength }
  },

  async select(req) {
    const part = requirePartDoc(resolveDoc(req, documents), 'select')
    if (!part.ok) return { ok: false, error: part.error }
    try {
      const result = await kernel.call('select', {
        doc: part.doc,
        selector: req.selector,
        docId: req.docId ?? 'mcp',
        files: readFiles(req.files),
      }) as SelectResult | null
      if (!result) {
        return { ok: false, error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)' }
      }
      return { ok: true, docHash: part.docHash, ...result }
    } catch (e) {
      // An empty match or a bad predicate expression is a tool failure, not a
      // protocol error: the message names the offending clause. A timeout or a
      // lost worker lands here too, with its own message.
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
  // stdin closed: the worker thread would keep the process alive otherwise.
  await kernel.dispose()
}

main().catch((e: unknown) => {
  console.error(`oversolved-mcp: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
