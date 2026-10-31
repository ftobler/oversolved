// The world-frame sentence served to MCP clients. It is generated from
// kernel/solverConstants.ts so a plane change cannot leave the instructions
// describing the old frame; the test compares the served text with this
// generator, never with a hand-typed copy.
//
// The preferred order keeps the familiar Top/Front/Right reading, then appends
// any plane added to BUILTIN_PLANES later, so a fourth builtin cannot be
// silently omitted from the sentence.

import { BUILTIN_PLANES } from '@/kernel/solverConstants'
import { normalToFrame } from '@/kernel/types3d'

const PREFERRED_ORDER = ['builtin_plane_top', 'builtin_plane_front', 'builtin_plane_right']

function labelOf(id: string): string {
  return id.replace(/^builtin_plane_/, '').split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function planeIds(): string[] {
  const preferred = PREFERRED_ORDER.filter(id => Object.hasOwn(BUILTIN_PLANES, id))
  const remaining = Object.keys(BUILTIN_PLANES).filter(id => !PREFERRED_ORDER.includes(id))
  return [...preferred, ...remaining]
}

function axisName(vector: unknown): string {
  if (!Array.isArray(vector)) throw new Error('BUILTIN_PLANES axis must be an array')
  const index = vector.findIndex(value => value !== 0)
  if (index < 0) throw new Error('BUILTIN_PLANES axis must have a non-zero component')
  const value = vector[index] as number
  return `${value > 0 ? '+' : '-'}${['X', 'Y', 'Z'][index]}`
}

/** "World is Y-up. Top: normal +Y, sketch x->+X, y->-Z. ..." */
export function worldFrameSentence(): string {
  const sentences = ['World is Y-up.']
  for (const id of planeIds()) {
    const plane = BUILTIN_PLANES[id]
    if (!plane) continue
    sentences.push(
      `${labelOf(id)}: normal ${axisName(plane.normal)}, sketch x->${axisName(plane.x_axis)}, y->${axisName(plane.y_axis)}.`,
    )
  }
  sentences.push('An extrude goes along the plane normal.')
  return sentences.join(' ')
}

/** The frame rule for a compare reference: the numbers are compared unchanged,
 *  so a source tool's frame has to be mapped by the author. */
export const REFERENCE_FRAME_SENTENCE =
  'A reference must already be in Oversolved\'s Y-up world frame; it is not rotated. '
  + 'A CadQuery XY extrusion along +Z maps to Front, and a box centred on CadQuery\'s origin needs a '
  + 'symmetric or re-origined extrusion. A centroid or bbox mismatch with volume and area passing is '
  + 'the likely frame difference, not the geometry.'

// The six world-axis face normals, in the order the docs table lists them.
const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [0, 0, 1], [0, 0, -1],
  [0, 1, 0], [0, -1, 0],
  [1, 0, 0], [-1, 0, 0],
]

export interface FaceFrameRow {
  normal: string
  xAxis: string
  yAxis: string
}

/**
 * The sketch axes a face with each world-axis normal gets, generated from the
 * one rule body faces and face sketches both use (`normalToFrame`). The docs
 * table is checked against this, so a frame change cannot leave the table
 * describing the old quarter turn.
 */
export function faceFrameRows(): FaceFrameRow[] {
  return FACE_NORMALS.map(normal => {
    const { x_axis, y_axis } = normalToFrame([...normal])
    return { normal: axisName(normal), xAxis: axisName(x_axis), yAxis: axisName(y_axis) }
  })
}

/** The face-sketch rule as one sentence, served in the initialize instructions. */
export function faceFrameSentence(): string {
  const rows = faceFrameRows()
    .map(row => `${row.normal}: x->${row.xAxis}, y->${row.yAxis}`)
    .join('; ')
  return 'A sketch on a face takes the face centroid as its origin and its in-plane axes from the face '
    + 'normal (x = normal x world +Z, or normal x world +X when |n_z| >= 0.9; y = normal x x). '
    + `The six axis normals give: ${rows}. A run or measure reply reports each `
    + 'sketch and add_plane feature\'s resolved frame in its `frames` map, so read the frame there '
    + 'instead of deriving it from the query.'
}

// Each add_plane mode's frame, in the order the plane schema lists the modes.
// The keys are the schema's mode enum (checked by faceFrameDocs.test.ts), so a mode
// added to the schema fails the test until its frame is stated here.
const ADD_PLANE_FRAME_BY_MODE: Record<string, string> = {
  offset: 'the parent axes, origin moved along the normal by offset',
  three_point: 'origin p1, x from p1 to p2, y in the p1-p2-p3 plane',
  plane_point: 'the parent axes, origin = parent origin + normal * the point\'s signed distance from the plane',
  line_angle: 'origin at the line start, x along the line, y from world +Z projected off x and swung by angle',
  edge_point: 'origin the point, x along the edge, y from the point to the edge line',
  on_face: 'origin the face centroid, the face normal, normalToFrame axes (a slash face pick keeps its own frame)',
  on_face_edge_angle: 'origin the face centroid, the face normal, x from the edge rotated by angle',
  origin_rotation: 'origin the origin field (a point ref or world coordinates), the parent axes (world XY when no plane is named) swung about rotation_axis by rotation_angle degrees',
}

/** The `add_plane` mode names the frame sentence covers, for the drift test. */
export function addPlaneFrameModes(): string[] {
  return Object.keys(ADD_PLANE_FRAME_BY_MODE)
}

/** The add_plane mode frames as one sentence, served in the initialize instructions. */
export function addPlaneFrameSentence(): string {
  const notes = Object.entries(ADD_PLANE_FRAME_BY_MODE)
    .map(([mode, note]) => `${mode}: ${note}`)
    .join('; ')
  return `An add_plane feature takes its frame from its mode: ${notes}. rotation turns x and y about the normal.`
}
