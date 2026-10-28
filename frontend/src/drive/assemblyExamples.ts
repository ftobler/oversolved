// Two runnable assembly examples served by the `mutations` tool: the pin on a
// plate (the smallest real mate) and the door frame (the door example's frame,
// abridged). Both bind named part documents and author every mate in one step,
// so a client can run them end to end after building the parts.
//
// The part scripts are plain part mutations; the assembly steps are the wire
// vocabulary from assemblyMutationCatalog.ts. The catalog test validates both
// examples against a resolver, and the real-kernel suite runs the pin on a plate.

import type { ScriptStep } from '@/drive/scriptRunner'
import type { Selector } from '@/kernel/select'
import type { AssemblyWireMutation } from './assemblyMutationCatalog'

export interface AssemblyMutationExample {
  name: string
  summary: string
  // doc_id -> the part script that builds that document.
  parts: Record<string, ScriptStep[]>
  steps: Array<{ mutation: AssemblyWireMutation }>
}

const AXES: Record<'x' | 'y' | 'z', [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

const FLAT_FACE = (axis: 'x' | 'y' | 'z', side: 'min' | 'max'): Selector => ({
  kind: 'face',
  where: { and: [{ type: 'flatface' }, { extreme: { axis: AXES[axis], side } }] },
})

const PLATE_PARTS: Record<string, ScriptStep[]> = {
  plate: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [100, 60] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10 } },
  ],
  pin: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Pin', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Pin', sketchQuery: '$sk1', distance: 20 } },
  ],
}

const PIN_ON_PLATE: AssemblyMutationExample = {
  name: 'pin_on_plate',
  summary: 'A fixed pin standing on a fixed 100 x 60 x 10 plate: one fixed mate, flip true for contact.',
  parts: PLATE_PARTS,
  steps: [
    { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
    { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
    { mutation: {
      type: 'add_mate',
      featureId: 'm1',
      kind: 'fixed',
      ref_a: { part: 'plate', selector: FLAT_FACE('z', 'max') },
      ref_b: { part: 'pin', selector: FLAT_FACE('z', 'min') },
      flip: true,
    } },
  ],
}

const SECTION = (docId: string, height: number): ScriptStep[] => [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: docId, plane: '@builtin_plane_top' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [-10, -10], p1: [10, 10] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: docId, sketchQuery: '$sk1', distance: height } },
]

const DOOR_FRAME: AssemblyMutationExample = {
  name: 'door_frame',
  summary: 'The door example frame: a cube corner block with a long and a short rail fixed to it (two mates).',
  parts: {
    cube: SECTION('cube', 20),
    rail_400: SECTION('rail_400', 400),
    rail_200: SECTION('rail_200', 200),
  },
  steps: [
    { mutation: { type: 'add_part', handle: 'con_bl', part: 'cube', fixed: true } },
    { mutation: { type: 'add_part', handle: 'left', part: 'rail_400', position: [50, 50, 50] } },
    { mutation: { type: 'add_part', handle: 'bottom', part: 'rail_200', position: [50, 50, 50] } },
    { mutation: {
      type: 'add_mate',
      featureId: 'm_left',
      kind: 'fixed',
      ref_a: { part: 'con_bl', selector: FLAT_FACE('y', 'max') },
      ref_b: { part: 'left', selector: FLAT_FACE('y', 'min') },
      flip: true,
    } },
    { mutation: {
      type: 'add_mate',
      featureId: 'm_bottom',
      kind: 'fixed',
      ref_a: { part: 'con_bl', selector: FLAT_FACE('x', 'max') },
      ref_b: { part: 'bottom', selector: FLAT_FACE('y', 'min') },
      flip: true,
    } },
  ],
}

export const ASSEMBLY_MUTATION_EXAMPLES: readonly AssemblyMutationExample[] = [PIN_ON_PLATE, DOOR_FRAME]
