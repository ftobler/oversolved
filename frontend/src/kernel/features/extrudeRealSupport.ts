// Shared fixtures for the extrude real-OCC tests. The single extrudeReal suite
// carried these builders and assertions inline; pulling them out keeps each
// describe group's file focused on its own scenarios and avoids a copied
// harness or duplicated spec literals.

import { beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

export const oc = await loadOcc()
export const solveBytes = loadSolver()

// Every split file guards its describe with skipIf(!oc || !solveBytes); this
// installs the Rust sketch solver once per file before its first test.
export function extrudeTestHarness(): SharedHarness {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })
  return h
}

export function rectSketchSk(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0],
      right: [w, 0, w, h],
      top: [w, h, 0, h],
      left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

export function extrudeSpec(sketchId: string, extrudeId: string, opts: {
  distance?: number; operation?: string; direction?: string; nested?: boolean
} = {}) {
  const distance = opts.distance ?? 5
  const direction = opts.direction ?? 'normal'
  const operation = opts.operation ?? 'add'
  if (opts.nested) {
    return {
      id: extrudeId, kind: 'extrude', label: 'Extrude',
      extrude: { sketch: '$' + sketchId, distance, direction, operation },
    }
  }
  return {
    id: extrudeId, kind: 'extrude', label: 'Extrude',
    sketch: '$' + sketchId, distance, direction, operation,
  }
}

export function fullRectExtrudeSpec(w = 10, h = 10, d = 5, direction = 'normal') {
  return { features: [rectSketchSk('sk1', w, h), extrudeSpec('sk1', 'ex1', { distance: d, direction })] }
}

export function assertMeshValid(mesh: Record<string, unknown>): void {
  const verts = mesh.vertices as number[][] | undefined
  const faces = mesh.faces as number[][] | undefined
  if (!verts || !faces) throw new Error('mesh missing vertices or faces')
  const n = verts.length
  if (n === 0) throw new Error('mesh has no vertices')
  if (faces.length === 0) throw new Error('mesh has no faces')
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i]
    if (a < 0 || a >= n) throw new Error(`face ${i}: vertex a=${a} out of range [0,${n})`)
    if (b < 0 || b >= n) throw new Error(`face ${i}: vertex b=${b} out of range [0,${n})`)
    if (c < 0 || c >= n) throw new Error(`face ${i}: vertex c=${c} out of range [0,${n})`)
    if (a === b || b === c || a === c) throw new Error(`face ${i} is degenerate: (${a},${b},${c})`)
  }
}

export function assertMeshBbox(mesh: Record<string, unknown>, xRange: [number, number], yRange: [number, number], zRange: [number, number], tol = 0.1): void {
  const verts = mesh.vertices as number[][] | undefined
  if (!verts) throw new Error('mesh missing vertices')
  const xs = verts.map((v) => v[0])
  const ys = verts.map((v) => v[1])
  const zs = verts.map((v) => v[2])
  const check = (vals: number[], lo: number, hi: number, axis: string) => {
    const actualLo = Math.min(...vals), actualHi = Math.max(...vals)
    if (actualLo < lo - tol) throw new Error(`${axis} min=${actualLo.toFixed(4)} expected >= ${lo}`)
    if (actualHi > hi + tol) throw new Error(`${axis} max=${actualHi.toFixed(4)} expected <= ${hi}`)
    if (actualLo > lo + tol) throw new Error(`${axis} min=${actualLo.toFixed(4)} not close to ${lo}`)
    if (actualHi < hi - tol) throw new Error(`${axis} max=${actualHi.toFixed(4)} not close to ${hi}`)
  }
  check(xs, xRange[0], xRange[1], 'x')
  check(ys, yRange[0], yRange[1], 'y')
  check(zs, zRange[0], zRange[1], 'z')
}

/** Two disjoint 2x2 rectangles in one sketch on the Front plane. */
export function disjointTwoRectSpec(operation = 'new') {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'a_bot', kind: 'line' as const }, { id: 'a_right', kind: 'line' as const },
          { id: 'a_top', kind: 'line' as const }, { id: 'a_left', kind: 'line' as const },
          { id: 'b_bot', kind: 'line' as const }, { id: 'b_right', kind: 'line' as const },
          { id: 'b_top', kind: 'line' as const }, { id: 'b_left', kind: 'line' as const },
        ],
        initial: {
          a_bot: [0, 0, 2, 0], a_right: [2, 0, 2, 2], a_top: [2, 2, 0, 2], a_left: [0, 2, 0, 0],
          b_bot: [5, 0, 7, 0], b_right: [7, 0, 7, 2], b_top: [7, 2, 5, 2], b_left: [5, 2, 5, 0],
        },
        constraints: [
          { id: 'ca1', kind: 'coincident' as const, a: { entity: 'a_bot', point: 'end' as const }, b: { entity: 'a_right', point: 'start' as const } },
          { id: 'ca2', kind: 'coincident' as const, a: { entity: 'a_right', point: 'end' as const }, b: { entity: 'a_top', point: 'start' as const } },
          { id: 'ca3', kind: 'coincident' as const, a: { entity: 'a_top', point: 'end' as const }, b: { entity: 'a_left', point: 'start' as const } },
          { id: 'ca4', kind: 'coincident' as const, a: { entity: 'a_left', point: 'end' as const }, b: { entity: 'a_bot', point: 'start' as const } },
          { id: 'cb1', kind: 'coincident' as const, a: { entity: 'b_bot', point: 'end' as const }, b: { entity: 'b_right', point: 'start' as const } },
          { id: 'cb2', kind: 'coincident' as const, a: { entity: 'b_right', point: 'end' as const }, b: { entity: 'b_top', point: 'start' as const } },
          { id: 'cb3', kind: 'coincident' as const, a: { entity: 'b_top', point: 'end' as const }, b: { entity: 'b_left', point: 'start' as const } },
          { id: 'cb4', kind: 'coincident' as const, a: { entity: 'b_left', point: 'end' as const }, b: { entity: 'b_bot', point: 'start' as const } },
          { id: 'ha', kind: 'horizontal' as const, target: { entity: 'a_bot' } },
          { id: 'hb', kind: 'horizontal' as const, target: { entity: 'b_bot' } },
          { id: 'la', kind: 'length' as const, target: { entity: 'a_bot' }, value: 2 },
          { id: 'lb', kind: 'length' as const, target: { entity: 'b_bot' }, value: 2 },
        ],
      },
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 3, direction: 'normal', operation },
    ],
  }
}

/**
 * Two equal overlapping circles bisected by a vertical line through their two
 * intersection points (the segmented_surface_after_extrude bug report). The
 * sketch subdivides into four adjacent regions (two crescents + two lens halves)
 * that are all connected, so extruding the whole sketch must fuse into ONE body.
 */
export function vennBisectSpec(operation = 'add') {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'cL', kind: 'circle' as const },
          { id: 'cR', kind: 'circle' as const },
          { id: 'ln', kind: 'line' as const },
          { id: 'pTop', kind: 'point' as const },
          { id: 'pBot', kind: 'point' as const },
        ],
        initial: {
          pTop: [0, 15],
          cR: [6.614378452301025, 7.5, 10],
          pBot: [0, 0],
          ln: [0, 15, 0, 0],
          cL: [-6.614378452301025, 7.5, 10],
        },
        constraints: [
          { id: 'eq', kind: 'equal_length' as const, a: '$cL', b: '$cR' },
          { id: 'co1', kind: 'coincident' as const, a: '$pTopxy', b: '$cR' },
          { id: 'co2', kind: 'coincident' as const, a: '$pTopxy', b: '$cL' },
          { id: 'co3', kind: 'coincident' as const, a: '$lnstart', b: '$pTopxy' },
          { id: 'co4', kind: 'coincident' as const, a: '$pBotxy', b: '$cR' },
          { id: 'co5', kind: 'coincident' as const, a: '$pBotxy', b: '$cL' },
          { id: 'co6', kind: 'coincident' as const, a: '$lnend', b: '$pBotxy' },
          { id: 'vert', kind: 'vertical' as const, target: '$ln' },
          { id: 'co7', kind: 'coincident' as const, a: '@builtin_origin', b: '$pBotxy' },
          { id: 'len', kind: 'length' as const, target: '$ln', value: 15 },
          { id: 'dia', kind: 'diameter' as const, target: '$cR', value: 20 },
        ],
      },
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation },
    ],
  }
}
