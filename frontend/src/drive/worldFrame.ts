// The world-frame sentence served to MCP clients. It is generated from
// kernel/solverConstants.ts so a plane change cannot leave the instructions
// describing the old frame; the test compares the served text with this
// generator, never with a hand-typed copy.

import { BUILTIN_PLANES } from '@/kernel/solverConstants'

const PLANE_ORDER = ['builtin_plane_top', 'builtin_plane_front', 'builtin_plane_right'] as const

const PLANE_LABELS: Record<(typeof PLANE_ORDER)[number], string> = {
  builtin_plane_top: 'Top',
  builtin_plane_front: 'Front',
  builtin_plane_right: 'Right',
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
  for (const id of PLANE_ORDER) {
    const plane = BUILTIN_PLANES[id]
    if (!plane) continue
    sentences.push(
      `${PLANE_LABELS[id]}: normal ${axisName(plane.normal)}, sketch x->${axisName(plane.x_axis)}, y->${axisName(plane.y_axis)}.`,
    )
  }
  sentences.push('An extrude goes along the plane normal.')
  return sentences.join(' ')
}
