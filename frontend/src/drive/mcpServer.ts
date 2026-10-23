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
import { validateSelector, typeVocabulary, type Selector } from '@/kernel/select'
import { parseReference, type TranslationReference } from '@/translations/corpus'
import { MUTATION_CATALOG_URI, mutationCatalogPayload } from '@/drive/mutationCatalogPayload'
import { DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'
import { worldFrameSentence } from '@/drive/worldFrame'

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

// A document argument is either the full doc or a docHash from an earlier
// call's reply. The store that resolves the hash lives in the entry script;
// this module only learns the shape. `run` may take neither (a fresh seeded
// document); the other tools need exactly one. mcpDocRef imports this shape so
// the protocol and the ops cannot drift.
export interface McpDocArguments {
  doc?: unknown
  docHash?: string
}

export interface McpRunRequest extends McpDocArguments {
  steps: unknown[]
  docId?: string
  files: McpFileRef[]
  // Default false: the reply carries docHash, not the whole document.
  returnDoc?: boolean
}

export interface McpMeasureRequest extends McpDocArguments {
  docId?: string
  files: McpFileRef[]
}

export interface McpExportRequest extends McpDocArguments {
  format: 'step' | 'stl'
  // Where the bytes are written, resolved against the server's cwd.
  out: string
  body?: string
  docId?: string
  files: McpFileRef[]
}

export interface McpSelectRequest extends McpDocArguments {
  selector: Selector
  docId?: string
  files: McpFileRef[]
}

export interface McpCompareRequest extends McpDocArguments {
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
  // A stored document as JSON text, addressed by the docHash a reply returned.
  // Null when the handle is unknown (evicted or never seen). This is the
  // out-of-band way to fetch the full document without inflating `run`.
  documentText(docHash: string): string | null
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

const DOC_SCHEMA = {
  type: 'object',
  description: 'A full part document. Pass either doc or docHash.',
}

const DOC_HASH_SCHEMA = {
  type: 'string',
  description: 'A content hash from an earlier reply. Pass either doc or docHash; the server keeps the last 32 documents.',
}

const VEC3_SCHEMA = {
  type: 'array',
  description: 'A world-space 3-vector.',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
}

// An extreme axis is a vector; the three letters are sugar the validator maps to
// the matching unit vector, so a hand-written selector may use either spelling.
const EXTREME_AXIS_SCHEMA = {
  anyOf: [
    {
      type: 'string',
      enum: ['x', 'y', 'z'],
      description: 'Sugar for [1,0,0], [0,1,0] or [0,0,1].',
    },
    VEC3_SCHEMA,
  ],
  description: 'The world axis to project on: "x", "y", "z" or a 3-vector.',
}

// The structured selector grammar advertised to MCP clients. The authoritative
// check is validateSelector (a recursive JSON Schema cannot express "exactly one
// predicate key" cleanly); this mirrors it so tools/list is honest about the
// shape, and an unknown predicate is still rejected before the engine runs.
//
// The `type` description lists the real vocabulary from typeVocabulary, the
// same tables the engine's typeOf and the query hierarchy read, so the schema
// cannot advertise a name the selector would never match.

const TYPE_DESCRIPTION = `Edge kind (${typeVocabulary('edge').join(', ')}) or face surface type (${typeVocabulary('face').join(', ')}).`

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
        type: { type: 'string', description: TYPE_DESCRIPTION },
        extreme: {
          type: 'object',
          required: ['axis', 'side'],
          properties: { axis: EXTREME_AXIS_SCHEMA, side: { enum: ['min', 'max'] } },
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

// The full document behind a run reply's docHash. A URI template rather than a
// listed resource: a session mints a new document per call, so the concrete
// URI cannot be known up front. This keeps the reply small (a 20-sketch ngon
// document is about 1500 lines) while the bytes stay one read away.
export const MCP_DOC_RESOURCE_TEMPLATE = 'oversolved://doc/{docHash}'
export const MCP_DOC_RESOURCE_PREFIX = 'oversolved://doc/'

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'commands',
    description: 'List the command registry: id, label, shortcut, undoable, param fields and the enabled verdict.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mutations',
    description: 'List the mutation vocabulary grouped by family (sketch, features, picks, part style, document), '
      + 'with each type\'s summary and fields, plus ready-to-run example scripts. Mutation steps author geometry; '
      + 'commands act on the current selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run',
    description: 'Run a script of command and mutation steps through one DocSession and the real kernel. '
      + 'Returns per-step results, the solve state and the resulting docHash; chain calls with docHash. '
      + 'ok means the steps applied and the solve ran: a feature can fail (status exception or partial) or '
      + 'warn while ok stays true, and features lists every such feature with its id, kind, status and message '
      + '(an empty list is a clean build). featureDeltas gives volume and bbox after every clean feature with the '
      + 'change from the previous checkpoint, so an additive step\'s contribution is visible; a failed, partial or '
      + 'warning feature has no delta row. With steps: [] the given document is solved once and the same fields '
      + 'are returned, which is how to inspect a document. The summary lists only the bodies the final solve left live. '
      + 'The full document is not returned by default (returnDoc: false); pass returnDoc: true, or read the '
      + 'resource ' + MCP_DOC_RESOURCE_TEMPLATE + ' with that docHash, when you need the bytes. ',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        doc: { ...DOC_SCHEMA, description: 'Starting document. Omit with docHash to start from a fresh seeded document.' },
        docHash: DOC_HASH_SCHEMA,
        steps: { type: 'array', items: { type: 'object' }, description: 'Script steps: {command,params} or {mutation}; mutation types: see the `mutations` tool.' },
        returnDoc: { type: 'boolean', description: 'Include the full final document in the reply (default false; the docHash resource serves it either way).' },
        docId: { type: 'string' },
        files: FILE_LIST_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'measure',
    description: 'Measure a document: body count, volume, surface area, centroid, bounding box and B-rep counts. '
      + 'Also returns features, the same failed-or-warning feature list a run reply carries.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC_SCHEMA,
        docHash: DOC_HASH_SCHEMA,
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
      required: ['reference'],
      properties: {
        doc: DOC_SCHEMA,
        docHash: DOC_HASH_SCHEMA,
        reference: {
          type: 'object',
          description: 'A reference.json payload with the measures flat at the top level, for example '
            + '{"source":{"tool":"hand","version":"1","file":"-"},"tolerance":{"rel":1e-4,"abs":0.01},'
            + '"bodies":1,"volume":12000,"area":3800,"centroid":[20,5,-15],"bbox":[0,0,-30,40,10,0]}. '
            + 'bodies, volume, area, centroid and bbox are required (the CadQuery runner '
            + 'frontend/scripts/cadqueryReference.py emits all five). '
            + 'Optional topology ("report" | "strict"), faces and edges. The measures are top-level keys, '
            + 'not nested under "measures".',
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
      required: ['format', 'out'],
      properties: {
        doc: DOC_SCHEMA,
        docHash: DOC_HASH_SCHEMA,
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
      + '(fillet, chamfer, hole, ...). Omit `where` to take every candidate: {from:"body_ex1",kind:"edge"} is '
      + 'all edges of that body. A `type` outside the kind\'s vocabulary is invalid params with the valid list '
      + 'and a "did you mean" hint. An empty match is an error naming the nearest-miss count per predicate. '
      + 'Returns the docHash it ran against. ' + worldFrameSentence(),
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        doc: DOC_SCHEMA,
        docHash: DOC_HASH_SCHEMA,
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
  {
    uri: MUTATION_CATALOG_URI,
    name: 'mutation-catalog',
    description: 'The mutation vocabulary grouped by family, plus ready-to-run example scripts. Same JSON as the `mutations` tool.',
    mimeType: 'application/json',
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

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new McpInvalidParams(`field "${name}" must be a boolean`)
  return value
}

function optionalDocHash(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpInvalidParams('field "docHash" must be a non-empty string')
  }
  return value
}

// `run` starts fresh when given neither, so only the both-present case is
// invalid there; every other doc-taking tool needs exactly one of the two.
function readDocArguments(
  record: { [key: string]: unknown },
  mode: 'run' | 'exactly-one',
): McpDocArguments {
  const doc = record.doc === undefined ? undefined : asObject(record.doc, 'field "doc"')
  const docHash = optionalDocHash(record.docHash)
  const count = (doc === undefined ? 0 : 1) + (docHash === undefined ? 0 : 1)
  if (mode === 'exactly-one' && count !== 1) {
    throw new McpInvalidParams('pass exactly one of "doc" or "docHash"')
  }
  if (mode === 'run' && count === 2) {
    throw new McpInvalidParams('pass at most one of "doc" or "docHash"')
  }
  return {
    ...(doc !== undefined && { doc }),
    ...(docHash !== undefined && { docHash }),
  }
}

function parseRunArgs(raw: unknown): McpRunRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docHash', 'steps', 'docId', 'files', 'returnDoc'])
  if (!Array.isArray(record.steps)) throw new McpInvalidParams('field "steps" must be an array')
  for (const [index, step] of record.steps.entries()) asObject(step, `field "steps[${index}]"`)
  const returnDoc = optionalBoolean(record.returnDoc, 'returnDoc')
  return {
    ...readDocArguments(record, 'run'),
    steps: record.steps,
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
    ...(returnDoc !== undefined && { returnDoc }),
  }
}

function parseMeasureArgs(raw: unknown): McpMeasureRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docHash', 'docId', 'files'])
  return {
    ...readDocArguments(record, 'exactly-one'),
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseCompareArgs(raw: unknown): McpCompareRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docHash', 'reference', 'docId', 'files'])
  const docArguments = readDocArguments(record, 'exactly-one')
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
    ...docArguments,
    reference,
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseExportArgs(raw: unknown): McpExportRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docHash', 'format', 'out', 'body', 'docId', 'files'])
  const docArguments = readDocArguments(record, 'exactly-one')
  const format = record.format
  if (format !== 'step' && format !== 'stl') throw new McpInvalidParams('field "format" must be "step" or "stl"')
  const out = record.out
  if (typeof out !== 'string' || out.length === 0) throw new McpInvalidParams('field "out" must be a non-empty string')
  const body = optionalString(record.body, 'body')
  return {
    ...docArguments,
    format,
    out,
    ...(body !== undefined && { body }),
    ...(optionalString(record.docId, 'docId') !== undefined && { docId: record.docId as string }),
    files: readFiles(record.files),
  }
}

function parseSelectArgs(raw: unknown): McpSelectRequest {
  const record = asObject(raw ?? {}, 'arguments')
  rejectUnknown(record, ['doc', 'docHash', 'selector', 'docId', 'files'])
  const docArguments = readDocArguments(record, 'exactly-one')
  const selectorRaw = requiredObject(record.selector, 'selector')
  let selector: Selector
  try {
    selector = validateSelector(selectorRaw)
  } catch (e) {
    throw new McpInvalidParams(`field "selector": ${e instanceof Error ? e.message : String(e)}`)
  }
  return {
    ...docArguments,
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
    case 'mutations':
      rejectUnknown(asObject(args ?? {}, 'arguments'), [])
      return { ok: true, ...mutationCatalogPayload() }
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
            instructions: 'Drive the CAD document headlessly: commands lists the registry, mutations lists the '
              + 'mutation vocabulary and example scripts, run executes scripts, '
              + 'measure reports geometry facts, compare checks a document against a reference, '
              + 'select finds faces/edges by predicate over the solve output, '
              + 'and export writes STEP or STL. The part-document JSON Schema is '
              + 'served as the resource ' + PART_DOC_SCHEMA_URI + ' and the mutation catalog as '
              + MUTATION_CATALOG_URI + '. The full document behind any reply docHash is the resource '
              + MCP_DOC_RESOURCE_TEMPLATE + ', so run replies stay small. Plane names are case-sensitive: use '
              + '@builtin_plane_front, @builtin_plane_top, @builtin_plane_right, a bare seeded name (Front, Top, '
              + 'Right) or @<planeId>; an unmatched plane is an error naming the valid planes. '
              + worldFrameSentence(),
          })
        case 'notifications/initialized':
          return null
        case 'ping':
          return isNotification ? null : success(id, {})
        case 'tools/list':
          return isNotification ? null : success(id, { tools: MCP_TOOLS })
        case 'resources/list':
          return isNotification ? null : success(id, { resources: MCP_RESOURCES })
        case 'resources/templates/list':
          return isNotification ? null : success(id, {
            resourceTemplates: [{
              uriTemplate: MCP_DOC_RESOURCE_TEMPLATE,
              name: 'document-by-hash',
              description: 'The full part document behind a reply docHash, as JSON. Unknown hashes are an invalid-params error naming the 32-document bound.',
              mimeType: 'application/json',
            }],
          })
        case 'resources/read': {
          if (isNotification) return null
          const params = asObject(request.params ?? {}, 'params')
          const uri = params.uri
          if (typeof uri !== 'string') throw new McpInvalidParams('resources/read needs a resource uri')
          if (uri.startsWith(MCP_DOC_RESOURCE_PREFIX)) {
            const docHash = uri.slice(MCP_DOC_RESOURCE_PREFIX.length)
            if (docHash.length === 0) {
              throw new McpInvalidParams(`document resource needs a hash: ${MCP_DOC_RESOURCE_TEMPLATE}`)
            }
            const text = ops.documentText(docHash)
            if (text === null) {
              throw new McpInvalidParams(
                `unknown docHash "${docHash}" (the server keeps the last ${DOC_HANDLE_CAPACITY} documents; run again to mint one)`,
              )
            }
            return success(id, { contents: [{ uri, mimeType: 'application/json', text }] })
          }
          if (uri !== PART_DOC_SCHEMA_URI && uri !== MUTATION_CATALOG_URI) {
            throw new McpInvalidParams(`unknown resource uri "${uri}"`)
          }
          if (uri === MUTATION_CATALOG_URI) {
            return success(id, {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(mutationCatalogPayload(), null, 1),
              }],
            })
          }
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
