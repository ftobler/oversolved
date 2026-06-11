// Dual-run parity gate for the topology Rust/WASM migration
// (feature/topology-to-rust.md). For a corpus of sketches, run the in-process TS
// `detectTopology` (the oracle) and the Rust path
// `decorateTopology(detect_topology_bytes(...))`, then assert they agree:
// structure exactly, query strings exactly, coordinates within tolerance.
//
// Skips when the node wasm artifact is absent (fresh checkout) so it never
// breaks `just frontend` before `just wasm` has run.

import { describe, it, expect } from "vitest"
import { detectTopology } from "./topology"
import { decorateTopology, solveTopology } from "./topologyDecorate"
import { loadTopology } from "@/wasm-kernel/loadTopology"

type Geom = Record<string, unknown>
const rad = (d: number): number => (d * Math.PI) / 180

// ─── enriched-geom builders (mirror enrichSketchEntity output) ───

function line(x0: number, y0: number, x1: number, y1: number): Geom {
  return { start: [x0, y0], end: [x1, y1] }
}
function circle(cx: number, cy: number, r: number): Geom {
  return { center: [cx, cy], radius: r }
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number): Geom {
  return {
    center: [cx, cy],
    radius: r,
    angle_start: a0,
    angle_end: a1,
    start: [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))],
    end: [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))],
  }
}
function ellipse(cx: number, cy: number, a: number, b: number, theta: number): Geom {
  return { kind: "ellipse", center: [cx, cy], a, b, theta }
}
function spline(p1: number[], c1: number[], c2: number[], p4: number[]): Geom {
  return { kind: "spline", start: p1, end: p4, c1, c2 }
}

// A corpus spanning the headline behaviors + every edge kind + classifiers.
const CORPUS: Record<string, Record<string, Geom>> = {
  single_square: {
    a: line(0, 0, 2, 0),
    b: line(2, 0, 2, 2),
    c: line(2, 2, 0, 2),
    d: line(0, 2, 0, 0),
  },
  standalone_circle: { c0: circle(0, 0, 1) },
  concentric_circles: { outer: circle(0, 0, 2), inner: circle(0, 0, 1) },
  line_slashes_circle: { c0: circle(0, 0, 1), l0: line(-2, 0, 2, 0) },
  two_crossing_lines: { h: line(-1, 0, 1, 0), v: line(0, -1, 0, 1) },
  standalone_ellipse: { e0: ellipse(0, 0, 3, 1, 20) },
  line_through_ellipse: { e0: ellipse(0, 0, 3, 1, 0), l0: line(-4, 0, 4, 0) },
  rect_with_circular_hole: {
    a: line(-5, -5, 5, -5),
    b: line(5, -5, 5, 5),
    c: line(5, 5, -5, 5),
    d: line(-5, 5, -5, -5),
    hole: circle(0, 0, 2),
  },
  arc_capped_slot: {
    top: line(-2, 1, 2, 1),
    bot: line(-2, -1, 2, -1),
    right: arc(2, 0, 1, 90, 270),
    left: arc(-2, 0, 1, 270, 450),
  },
  closed_spline_blob: {
    s0: spline([0, 0], [2, 3], [-2, 3], [0, 0]),
  },
  ellipse_ellipse_overlap: {
    e0: ellipse(-1, 0, 2, 1, 0),
    e1: ellipse(1, 0, 2, 1, 0),
  },
  square_split_by_line: {
    // Two faces sharing the same boundary entity set -> line-division classifiers.
    a: line(0, 0, 4, 0),
    b: line(4, 0, 4, 4),
    c: line(4, 4, 0, 4),
    d: line(0, 4, 0, 0),
    mid: line(2, 0, 2, 4),
  },
}

// ─── tolerant deep compare (structure exact, query strings exact, coords ~) ───

function diff(ts: unknown, rs: unknown, path: string, out: string[]): void {
  if (typeof ts === "number" && typeof rs === "number") {
    const tol = 1e-6 * Math.max(1, Math.abs(ts), Math.abs(rs))
    if (Math.abs(ts - rs) > tol) out.push(`${path}: ${ts} != ${rs}`)
    return
  }
  if (Array.isArray(ts) || Array.isArray(rs)) {
    if (!Array.isArray(ts) || !Array.isArray(rs)) {
      out.push(`${path}: array vs non-array`)
      return
    }
    if (ts.length !== rs.length) {
      out.push(`${path}: length ${ts.length} != ${rs.length}`)
      return
    }
    for (let i = 0; i < ts.length; i++) diff(ts[i], rs[i], `${path}[${i}]`, out)
    return
  }
  if (ts !== null && rs !== null && typeof ts === "object" && typeof rs === "object") {
    const tk = Object.keys(ts as object).sort()
    const rk = Object.keys(rs as object).sort()
    if (tk.join(",") !== rk.join(",")) {
      out.push(`${path}: keys [${tk}] != [${rk}]`)
      return
    }
    for (const k of tk) diff((ts as Geom)[k], (rs as Geom)[k], `${path}.${k}`, out)
    return
  }
  // strings, booleans, null: exact.
  if (ts !== rs) out.push(`${path}: ${JSON.stringify(ts)} != ${JSON.stringify(rs)}`)
}

const topo = loadTopology()

describe.skipIf(!topo)("topology Rust/WASM parity with the TS oracle", () => {
  const runRust = (richGeom: Record<string, Geom>, featureId: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify(Object.entries(richGeom)))
    const out = topo!(bytes)
    return decorateTopology(JSON.parse(new TextDecoder().decode(out)), featureId)
  }

  for (const [name, richGeom] of Object.entries(CORPUS)) {
    it(`matches on ${name}`, () => {
      const featureId = `feat_${name}`
      const tsOut = detectTopology(richGeom, featureId)
      const rsOut = runRust(richGeom, featureId)
      const diffs: string[] = []
      diff(tsOut, rsOut, "topology", diffs)
      expect(diffs).toEqual([])
    })
  }

  it("solveTopology routes through Rust when a topology fn is injected", () => {
    const rg = CORPUS.single_square
    const viaHelper = solveTopology(rg, "feat_helper", topo)
    const viaRust = runRust(rg, "feat_helper")
    const diffs: string[] = []
    diff(viaHelper, viaRust, "topology", diffs)
    expect(diffs).toEqual([])
  })
})
