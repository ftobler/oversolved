// The MCP server over the headless surface: a hand-rolled JSON-RPC 2.0 stdio
// protocol (initialize, tools/list, tools/call, resources/list, resources/read)
// with no SDK dependency. The transport is newline-delimited JSON, one message
// per line, which is what the MCP stdio transport specifies.
//
// The tool table is data (name, description, inputSchema) declared here, and
// every call is validated against the same shape before the injected ops run,
// so tools/list cannot advertise a call the server would refuse. The ops are
// injected: this module is framework-free and does no I/O itself, the entry
// script frontend/scripts/mcpServer.ts wires the real kernel, the shared
// headless operations and the filesystem.
//
// One warning for ops implementers: DocSession work must be serialized. The
// stdio loop awaits each message before reading the next, so the process-wide
// kernel state (solveLocally's cross-solve cache) never sees two sessions at
// once; an ops implementation that answers out of band would break that.

import { PART_DOC_SCHEMA_URI } from '@/persistence/partDocSchema'
import { validateSelector, type Selector } from '@/kernel/select'
import { parseReference, type TranslationReference } from '@/translations/corpus'

// The protocol revisions whose initialize handshake this server accepts. The
// three methods implemented here exist unchanged in all of them, so a client
// asking for one gets it back and anything else falls back to the oldest.
const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

const SERVER_NAME = 'oversolved-mcp'
const SERVER_VERSION = '1.0.0'

/** One file the document's import_step features need: registry id plus path. */
export interface McpFileRef {
  id: string
  path: string
}

export interface McpRunRequest {
  doc?: unknown
  steps: unknown[]
  docId?: string
  files: McpFileRef[]
}

export interface McpMeasureRequest {
  doc: unknown
  docId?: string
  files: McpFileRef[]
}

export interface McpExportRequest {
  doc: unknown
  format: 'step' | 'stl'
  // Where the bytes are written, resolved against the server's cwd.
  out: string
  body?: string
  docId?: string
  files: McpFileRef[]
}

export interface McpSelectRequest {
  doc: unknown
  selector: Selector
  docId?: string
  files: McpFileRef[]
}

export interface McpCompareRequest {
  doc: unknown
  reference: TranslationReference
  docId?: string
  files: McpFileRef[]
}

// A tool payload: JSON-safe, carrying `ok` like every other Result in the
// project. `ok: false` means the tool ran and failed (a bad document, no
// solid, an unavailable kernel) and the server sets the MCP isError flag; an
// exception from ops is a bug and the server reports an internal error.
export interface McpToolPayload {
  ok: boolean
  [key: string]: unknown
}

export interface McpCadOps {
  commands(): Promise<McpToolPayload>
  run(req: McpRunRequest): Promise<McpToolPayload>
  measure(req: McpMeasureRequest): Promise<McpToolPayload>
  compare(req: McpCompareRequest): Promise<McpToolPayload>
  export(req: McpExportRequest): Promise<McpToolPayload>
  // The part-document JSON Schema, served as the MCP resource. Injected as a
  // string so the server does not depend on the schema's build graph; only the
  // URI constant (from partDocSchema, the same source) is imported here.
  partDocSchema(): string
  select(req: McpSelectRequest): Promise<McpToolPayload>
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const FILE_LIST_SCHEMA = {
  type: 'array',
  description: 'STEP bytes for import_step features: the feature file_id and a file path.',
  items: {
    type: 'object',
    required: ['id', 'path'],
    properties: { id: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
}

const VEC3_SCHEMA = {
  type: 'array',
  description: 'A world-space 3-vector.',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
}

// The structured selector grammar advertised to MCP clients. The authoritative
// check is validateSelector (a recursive JSON Schema cannot express "exactly one
// predicate key" cleanly); this mirrors it so tools/list is honest about the
// shape, and an unknown predicate is still rejected before the engine runs.
//
// A `$ref` fragment resolves against the schema-document root, which for a tool
// is the whole `inputSchema`. These definitions are therefore spread into that
// root as `$defs` and the `selector` property refs into them; nesting the
// definitions under the property would leave `#/$defs/selector` dangling.
const SELECTOR_DEFS: Record<string, unknown> = {
  $defs: {
    predicate: {
      type: 'object',
      description: 'A selector predicate; exactly one key.',
      minProperties: 1,
      maxProperties: 1,
      properties: {
        and: { type: 'array', items: { $ref: '#/$defs/predicate' }, minItems: 1 },
        or: { type: 'array', items: { $ref: '#/$defs/predicate' }, minItems: 1 },
        not: { $ref: '#/$defs/predicate' },
        parallel: VEC3_SCHEMA,
        perpendicular: VEC3_SCHEMA,
        type: { type: 'string', description: 'Edge kind or face surface_type.' },
        extreme: {
          type: 'object',
          required: ['axis', 'side'],
          properties: { axis: VEC3_SCHEMA, side: { enum: ['min', 'max'] } },
          additionalProperties: false,
        },
        on_face: { $ref: '#/$defs/selector' },
        created_by: { type: 'string' },
        radius: {
          anyOf: [
            { type: 'number' },
            {
              type: 'object',
              properties: { eq: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' } },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    selector: {
      type: 'object',
      required: ['kind'],
      properties: {
        from: { type: 'string', description: 'Body id to restrict to; omit for every body.' },
        kind: { enum: ['edge', 'face'] },
        where: { $ref: '#/$defs/predicate' },
      },
      additionalProperties: false,
    },
  },
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'commands',
    description: 'List the command registry: id, label, shortcut, undoable, param fields and the enabled verdict.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run',
    description: 'Run a script of command and mutation steps through one DocSession and the real kernel. '
      + 'Returns the final document (for chaining), its hash, per-step results and solve state.',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        doc: { type: 'object', description: 'Starting document; omit to start from a fresh seeded document.' },
        steps: { type: 'array', items: { type: 'object' }, description: 'Script steps: {command,params} or {mutation}.' },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'measure',
    description: 'Measure a document: body count, volume, surface area, centroid, bounding box and B-rep counts.',
    inputSchema: {
      type: 'object',
      required: ['doc'],
      properties: {
        doc: { type: 'object' },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'compare',
    description: 'Measure a document and compare it against a reference at the reference\'s tolerance. '
      + 'Returns pass plus one row per measure (ours, theirs, delta, within); a failing row is data, not a tool error.',
    inputSchema: {
      type: 'object',
      required: ['doc', 'reference'],
      properties: {
        doc: { type: 'object' },
        reference: {
          type: 'object',
          description: 'A reference.json payload: source {tool, version, file}, tolerance {rel, abs}, '
            + 'optional topology ("report" | "strict"), and the measures bodies, volume, area, centroid, '
            + 'bbox, optional faces and edges.',
        },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export',
    description: 'Export a document to STEP or STL and write the bytes to `out`. Returns the written path and size.',
    inputSchema: {
      type: 'object',
      required: ['doc', 'format', 'out'],
      properties: {
        doc: { type: 'object' },
        format: { type: 'string', enum: ['step', 'stl'] },
        out: { type: 'string' },
        body: { type: 'string', description: 'Export this single body id; omit for the whole assembly.' },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Find faces or edges by predicate over the solved document and return the query strings a click '
      + 'would store, plus a geometry summary per item. Run it after `run`, then feed the queries to a feature '
      + '(fillet, chamfer, hole, ...). An empty match is an error naming the nearest-miss count per predicate.',
    inputSchema: {
      type: 'object',
      required: ['doc', 'selector'],
      properties: {
        doc: { type: 'object' },
        selector: { $ref: '#/$defs/selector' },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
      ...SELECTOR_DEFS,
    },
  },
]

/** The resources the server advertises. The part-document schema is the one
 *  contract an agent reads before authoring a document, so it does not have to
 *  infer the format from tool-call examples. */
export const MCP_RESOURCES: readonly { uri: string; name: string; description: string; mimeType: string }[] = [
  {
    uri: PART_DOC_SCHEMA_URI,
    name: 'part-document-schema',
    description: 'JSON Schema for an Oversolved part document: feature refs are @id and params are nested under the kind key.',
    mimeType: 'application/schema+json',
  },
]

// Argument failures are JSON-RPC invalid-params, distinct from a tool that ran
// and failed; the message names the offending field.
class McpInvalidParams extends Error {}
export type JsonRpcId = string | number | null

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export interface McpServer {
  handle(message: unknown): Promise<JsonRpcResponse | null>
  // The stdio framing: parse one line, answer one line (null for a
  // notification or an unanswerable message).
  handleLine(line: string): Promise<string | null>
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpInvalidParams(`${what} must be an object`)
  }
  return raw as Record<string, unknown>
}

// Field readers that name the field in the failure, so a caller learns which
// argument was wrong instead of guessing.
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new McpInvalidParams(`field "${name}" must be a string`)
  return value
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) throw new McpInvalidParams(`field "${name}" is required`)
  return asObject(value, `field "${name}"`)
}

function readFiles(value: unknown): McpFileRef[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new McpInvalidParams('field "files" must be an array')
  return value.map((entry, index) => {
    const record = asObject(entry, `field "files[${index}]"`)
    const id = record.id
    const path = record.path
    if (typeof id !== 'string' || id.length === 0) throw new McpInvalidParams(`field "files[${index}].id" must be a non-empty string`)
    if (typeof path !== 'string' || path.length === 0) throw new McpInvalidParams(`field "files[${index}].path" must be a non-empty string`)
    return { id, path }
  })
}

// Reject unknown fields by name: the inputSchema is additionalProperties false
// on every tool, so a typo must fail here rather than be silently ignored.
function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new McpInvalidParams(`unknown field "${key}"`)
  }
}

function parseRunArgs(raw: unknown): McpRunRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'steps', 'docId', 'files'])
  if (!Array.isArray(record.steps)) throw new McpInvalidParams('field "steps" must be an array')
  for (const [index, step] of record.steps.entries()) asObject(step, `field "steps[${index}]"`)
  const doc = record.doc === undefined ? undefined : asObject(record.doc, 'field "doc"')
  return {
    ...(doc !== undefined && { doc }),
    steps: record.steps,
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseMeasureArgs(raw: unknown): McpMeasureRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docId', 'files'])
  return {
    doc: requiredObject(record.doc, 'doc'),
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseCompareArgs(raw: unknown): McpCompareRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'reference', 'docId', 'files'])
  const referenceRaw = requiredObject(record.reference, 'reference')
  let reference: TranslationReference
  try {
    // The same validator the corpus and the CLI use, so a malformed reference
    // is invalid params here rather than a tool error after a build.
    reference = parseReference('reference', JSON.stringify(referenceRaw))
  } catch (e) {
    throw new McpInvalidParams(`field "reference": ${e instanceof Error ? e.message : String(e)}`)
  }
  return {
    doc: requiredObject(record.doc, 'doc'),
    reference,
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseExportArgs(raw: unknown): McpExportRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'format', 'out', 'body', 'docId', 'files'])
  const format = record.format
  if (format !== 'step' && format !== 'stl') throw new McpInvalidParams('field "format" must be "step" or "stl"')
  const out = record.out
  if (typeof out !== 'string' || out.length === 0) throw new McpInvalidParams('field "out" must be a non-empty string')
  const body = optionalString(record.body, 'body')
  return {
    doc: requiredObject(record.doc, 'doc'),
    format,
    out,
    ...(body !== undefined && { body }),
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseSelectArgs(raw: unknown): McpSelectRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'selector', 'docId', 'files'])
  const selectorRaw = requiredObject(record.selector, 'selector')
  let selector: Selector
  try {
    selector = validateSelector(selectorRaw)
  } catch (e) {
    throw new McpInvalidParams(`field "selector": ${e instanceof Error ? e.message : String(e)}`)
  }
  return {
    doc: requiredObject(record.doc, 'doc'),
    selector,
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

async function callTool(ops: McpCadOps, name: string, args: unknown): Promise<McpToolPayload> {
  switch (name) {
    case 'commands':
      // The schema takes no arguments; a typo must still be rejected by name.
      rejectUnknown(asObject(args ?? {}, 'arguments'), [])
      return ops.commands()
    case 'run': return ops.run(parseRunArgs(args))
    case 'measure': return ops.measure(parseMeasureArgs(args))
    case 'compare': return ops.compare(parseCompareArgs(args))
    case 'export': return ops.export(parseExportArgs(args))
    case 'select': return ops.select(parseSelectArgs(args))
    default: throw new McpInvalidParams(`unknown tool "${name}"`)
  }
}

function negotiatedProtocolVersion(params: unknown): string {
  const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
  return typeof requested === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION
}

export function createMcpServer(ops: McpCadOps): McpServer {
  async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return failure(null, -32600, 'invalid request: expected a JSON-RPC object')
    }
    const request = message as { id?: JsonRpcId; method?: unknown; params?: unknown }
    if (typeof request.method !== 'string') {
      // A message carrying result or error is a response to a request this
      // server never made; it is not a request and gets no answer.
      if ('result' in request || 'error' in request) return null
      return request.id === undefined ? null : failure(request.id, -32600, 'invalid request: missing method')
    }
    const id = request.id === undefined ? null : request.id
    const isNotification = request.id === undefined
    try {
      switch (request.method) {
        case 'initialize':
          return isNotification ? null : success(id, {
            protocolVersion: negotiatedProtocolVersion(request.params),
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: 'Drive the CAD document headlessly: commands lists the registry, run executes scripts, '
              + 'measure reports geometry facts, select finds faces/edges by predicate over the solve output, '
              + 'and export writes STEP or STL. The part-document JSON Schema is '
              + 'served as the resource ' + PART_DOC_SCHEMA_URI + '.',
          })
        case 'notifications/initialized':
          return null
        case 'ping':
          return isNotification ? null : success(id, {})
        case 'tools/list':
          return isNotification ? null : success(id, { tools: MCP_TOOLS })
        case 'resources/list':
          return isNotification ? null : success(id, { resources: MCP_RESOURCES })
        case 'resources/read': {
          if (isNotification) return null
          const params = asObject(request.params ?? {}, 'params')
          const uri = params.uri
          if (typeof uri !== 'string') throw new McpInvalidParams('resources/read needs a resource uri')
          if (uri !== PART_DOC_SCHEMA_URI) throw new McpInvalidParams(`unknown resource uri "${uri}"`)
          return success(id, {
            contents: [{ uri, mimeType: 'application/schema+json', text: ops.partDocSchema() }],
          })
        }
        case 'tools/call': {
          if (isNotification) return null
          const params = asObject(request.params ?? {}, 'params')
          const name = params.name
          if (typeof name !== 'string') throw new McpInvalidParams('tools/call needs a tool name')
          const payload = await callTool(ops, name, params.arguments)
          return success(id, {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }],
            ...(payload.ok === false && { isError: true }),
          })
        }
        default:
          return isNotification ? null : failure(id, -32601, `unknown method "${request.method}"`)
      }
    } catch (e) {
      if (e instanceof McpInvalidParams) return isNotification ? null : failure(id, -32602, e.message)
      // An ops bug must not kill the loop: report it and keep serving.
      return isNotification ? null : failure(id, -32603, e instanceof Error ? e.message : String(e))
    }
  }

  return {
    handle,
    handleLine: async (line: string): Promise<string | null> => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return JSON.stringify(failure(null, -32700, 'parse error'))
      }
      const response = await handle(message)
      return response === null ? null : JSON.stringify(response)
    },
  }
}
