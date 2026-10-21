// The world-frame sentence served to MCP clients. It is generated from
// kernel/solverConstants.ts so a plane change cannot leave the instructions
// describing the old frame; the test compares the served text with this
// generator, never with a hand-typed copy.
//
// The preferred order keeps the familiar Top/Front/Right reading, then appends
// any plane added to BUILTIN_PLANES later, so a fourth builtin cannot be
// silently omitted from the sentence.

import { BUILTIN_PLANES } from '@/kernel/solverConstants'

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
