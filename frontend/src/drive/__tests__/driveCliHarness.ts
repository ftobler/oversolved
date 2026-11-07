// Shared harness for the drive CLI and MCP server end-to-end suites
// (cliSmoke, cliSmokePaths, cliSmokeMeasure, mcpSmoke): the real-kernel gate,
// the CLI spawn and the scripts they build from.
//
// The suites were one file; every test spawns its own node child that loads
// OCC, so the file ran ~350 s in a single fork and set the floor of the whole
// vitest run. Split by theme they run on separate forks. They share TMP_DIR,
// so every file name a test writes there is unique across the four files.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DRIVE_NODE_ARGS, FRONTEND_DIR } from './mcpStdioClient'

const execFileAsync = promisify(execFile)

// The project-internal tmp at the worktree root; never the system /tmp.
export const TMP_DIR = path.resolve(FRONTEND_DIR, '../tmp/drive-cli-smoke')

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

/** Skip the suites when OCC.js or the Rust node build is absent, or on a Node
 *  too old for --experimental-strip-types. */
export const driveUnavailable = !occInstalled() || !loadSolver() || !stripTypes

export interface CliResult {
  status: number
  payload: Record<string, unknown>
  stdout: string
}

// Asynchronous so the vitest worker's event loop stays free while the child
// solves; a synchronous spawn for a minute of OCC work starves the worker RPC.
export async function drive(...args: string[]): Promise<CliResult> {
  let stdout = ''
  let status = 0
  try {
    const result = await execFileAsync('node', [
      ...DRIVE_NODE_ARGS,
      'scripts/driveCli.ts',
      ...args,
    ], { cwd: FRONTEND_DIR, encoding: 'utf8' })
    stdout = result.stdout
  } catch (e) {
    const error = e as { status?: number; stdout?: string }
    stdout = error.stdout ?? ''
    status = error.status ?? 1
  }
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return { status, payload: JSON.parse(lastLine) as Record<string, unknown>, stdout }
}

// AddOptimal can land a coordinate a few ulp off the analytic corner on a
// curved body (a fillet), so bboxes compare component-wise, not by identity.
export function expectBbox(actual: unknown, expected: number[]): void {
  const bbox = actual as number[]
  expect(bbox).toHaveLength(expected.length)
  bbox.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9))
}

export const BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
  ],
}

// The first real agent session's part: a 40 x 30 sketch on Top extruded 10
// along +Y. Its four Y-parallel edges are the ones `select {parallel:[0,1,0]}`
// returns, each 10 long.
export const SESSION_BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
  ],
}

export const COMMAND_SCRIPT = {
  steps: [
    { command: 'toggle_plane_visibility' },
    { command: 'toggle_sketch_plane_visibility' },
  ],
}

// Three separate posts and a bar that fuses into the first one: the bar's
// "also touches" warning names the other two until a union fuses them, which is
// the kernel's `resolved_warning`. A run that adds the union carries it as an
// informational note, the one text the CLI printers must pass through.
export const RESOLVED_WARNING_SCRIPT = {
  steps: [
    ...[
      { n: 1, x0: 0 },
      { n: 2, x0: 5 },
      { n: 3, x0: 10 },
    ].flatMap(({ n, x0 }) => [
      { mutation: { type: 'add_sketch', featureId: `sk${n}`, plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: `sk${n}`, p0: [x0, 0], p1: [x0 + 2, 2] } },
      { mutation: { type: 'add_extrude', featureId: `ex${n}`, sketchQuery: `$sk${n}`, distance: 3, operation: 'new' } },
    ]),
    { mutation: { type: 'add_sketch', featureId: 'sk4', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk4', p0: [1, 0], p1: [11, 2] } },
    { mutation: { type: 'add_extrude', featureId: 'ex4', sketchQuery: '$sk4', distance: 3 } },
    { mutation: { type: 'add_boolean', featureId: 'bo1', operation: 'union', target: 'body_ex1', tools: ['body_ex2', 'body_ex3'] } },
  ],
}

// The 10 x 10 x 5 box with one edge filleted (radius 1). The edge alias
// `?body_ex1:edge:0` is the deterministic index the builder registers, so the
// script selects the same edge on every run.
export const FILLET_SCRIPT = {
  steps: [
    ...BOX_SCRIPT.steps,
    { mutation: { type: 'add_fillet', featureId: 'f1', label: 'Fillet' } },
    { mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?body_ex1:edge:0' } },
  ],
}

// One typed dimension change: extrude 5 -> 8, the "edit a dimension and
// rebuild" path.
export const EDIT_SCRIPT = {
  steps: [
    { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 8 } },
  ],
}

// Adopt a STEP file as the document's only solid; the bytes arrive through
// --file as f1.
export const IMPORT_SCRIPT = {
  steps: [
    { mutation: { type: 'add_import_step', featureId: 'imp1', fileId: 'f1' } },
  ],
}
