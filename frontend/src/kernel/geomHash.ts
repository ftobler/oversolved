// Ported from the removed Python kernel (oversolved/kernel/geom_hash.py). Stable face/edge/vertex identity from
// geometry attributes rounded to 4 decimals. Cross-language byte-exact hash
// parity with Python is the phase 2c gate: the dual-run fixture diffs these
// outputs against hashlib, so the float formatting below must reproduce
// CPython's str(round(v, 4)) exactly. See geomHash.test.ts.

import { sha256Hex } from "./sha256"

/**
 * Reproduce CPython `str(round(v, 4))`.
 *
 * round(v, 4) is correctly rounded on the exact double value; JS `toFixed(4)`
 * is likewise correctly rounded on the exact value, so they agree on every
 * realistic CAD coordinate (true decimal ties at the 4th place are not
 * representable as doubles, so Python's round-half-even vs toFixed's
 * round-half-up never diverge). We then strip trailing zeros to match Python's
 * shortest-repr, keeping one fractional digit.
 *
 * Negative zero is normalized to "0.0" (mirrors Python `_r4str`): a geometry hash
 * must not distinguish +0 from -0, since OCC builds disagree on the sign of a
 * mathematically-zero coordinate (OCC.js emits a -0.0 arc x_axis component where
 * OCP emits +0.0), which would otherwise flip the 4dp hash across kernels.
 *
 * Exponential form (|v| >= 1e21 in JS, >= 1e16 in Python) is out of range for
 * CAD millimetre coordinates and intentionally not reconciled here.
 */
export function pyRound4Str(v: number): string {
  if (Number.isNaN(v)) return "nan"
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf"
  let s = v.toFixed(4)
  s = s.replace(/(\.\d*?)0+$/, "$1")
  if (s.endsWith(".")) s += "0"
  if (!s.includes(".")) s += ".0"
  if (s === "-0.0") s = "0.0"  // normalize negative zero (matches Python _r4str)
  return s
}

/**
 * True if a lineage map is keyed by stable geometry hashes (this feature),
 * not the legacy OCC subshape hashes. *prefix* is "gface_" / "gedge_".
 */
export function isGeomKeyedLineage(
  lineage: Record<string, unknown> | null | undefined,
  prefix: string,
): boolean {
  if (!lineage) return false
  const first = Object.keys(lineage)[0]
  return first !== undefined && first.startsWith(prefix)
}

function arcAngleDeg(edge: Record<string, unknown>, start: boolean): number {
  const degKey = start ? "angle_start_deg" : "angle_end_deg"
  const radKey = start ? "angle_start" : "angle_end"
  if (degKey in edge) return Number(edge[degKey])
  if (radKey in edge) return (Number(edge[radKey]) * 180) / Math.PI
  return 0.0
}

/** "gface_<hash>" from centroid + normal rounded to 4 dp. Area is excluded. */
export function faceGeometryHash(centroid: number[], normal: number[]): string {
  const parts = centroid.map(pyRound4Str).concat(normal.map(pyRound4Str))
  return "gface_" + sha256Hex(parts.join("|")).slice(0, 16)
}

/** "gnormal_<hash>" from the face normal alone (orientation-only fallback). */
export function faceNormalHash(normal: number[]): string {
  const parts = normal.map(pyRound4Str)
  return "gnormal_" + sha256Hex(parts.join("|")).slice(0, 16)
}

function curveDataItems(curveData: Record<string, unknown>): string[] {
  const items: string[] = []
  for (const key of Object.keys(curveData).sort()) {
    const val = curveData[key]
    items.push(key)
    if (Array.isArray(val)) {
      for (const element of val) {
        if (Array.isArray(element)) {
          for (const x of element) items.push(pyRound4Str(Number(x)))
        } else {
          items.push(pyRound4Str(Number(element)))
        }
      }
    } else if (typeof val === "number") {
      // Scalar numbers are formatted as floats. The one integer-typed scalar in
      // real NURBS curve_data is `degree`, which Python renders without a
      // decimal (str(round(3, 4)) == "3"); JS cannot tell an int from a
      // float-valued number, so that field is a known parity gap to close when
      // the spline geometry reader is ported (phase 2e/2f), where the hash
      // input is defined alongside the producer.
      items.push(pyRound4Str(val))
    } else if (typeof val === "boolean") {
      // In Python bool is an int subclass, so str(round(True, 4)) == "1".
      items.push(val ? "1" : "0")
    } else {
      items.push(val === null || val === undefined ? "None" : String(val))
    }
  }
  return items
}

/** "gedge_<hash>" for an edge dict. Throws if an arc lacks center/radius. */
export function edgeGeometryHash(edge: Record<string, unknown>): string {
  const kind = (edge["kind"] as string) ?? ""
  const items: string[] = [kind]
  if (kind === "line") {
    const start = edge["start"] as number[]
    const end = edge["end"] as number[]
    for (const pt of [start, end]) for (const v of pt) items.push(pyRound4Str(v))
  } else if (kind === "circle" || kind === "arc") {
    if (kind === "arc") {
      const missing = ["center", "radius"].filter(k => !(k in edge))
      if (missing.length) {
        throw new Error(`arc edge missing geometry fields: ${missing}`)
      }
    }
    // Absent fields fall back to Python int literals, which str(round(int, 4))
    // renders without a decimal point ("0", "1"); present fields are floats.
    items.push("radius" in edge ? pyRound4Str(Number(edge["radius"])) : "0")
    if ("center" in edge) for (const v of edge["center"] as number[]) items.push(pyRound4Str(v))
    else items.push("0", "0", "0")
    if (kind === "arc") {
      items.push(pyRound4Str(arcAngleDeg(edge, true)))
      items.push(pyRound4Str(arcAngleDeg(edge, false)))
      if ("axis" in edge) for (const v of edge["axis"] as number[]) items.push(pyRound4Str(v))
      else items.push("0", "0", "1")
      if ("x_axis" in edge) for (const v of edge["x_axis"] as number[]) items.push(pyRound4Str(v))
      else items.push("1", "0", "0")
    }
  } else if (kind === "ellipse") {
    // Geometry-determined so two distinct ellipses never collide: center,
    // semi-axes, plane normal, major-axis direction, plus the parametric range
    // so a partial elliptical arc differs from the full ellipse. See
    // edgeGeomHashCoupling.
    items.push("a" in edge ? pyRound4Str(Number(edge["a"])) : "0")
    items.push("b" in edge ? pyRound4Str(Number(edge["b"])) : "0")
    if ("center" in edge) for (const v of edge["center"] as number[]) items.push(pyRound4Str(v))
    else items.push("0", "0", "0")
    if ("axis" in edge) for (const v of edge["axis"] as number[]) items.push(pyRound4Str(v))
    else items.push("0", "0", "1")
    if ("x_axis" in edge) for (const v of edge["x_axis"] as number[]) items.push(pyRound4Str(v))
    else items.push("1", "0", "0")
    items.push("angle_start" in edge ? pyRound4Str(Number(edge["angle_start"])) : "0")
    items.push("angle_end" in edge ? pyRound4Str(Number(edge["angle_end"])) : "0")
  } else {
    const curveData = edge["curve_data"] as Record<string, unknown> | undefined
    if (curveData) {
      items.push(...curveDataItems(curveData))
    } else if ("points" in edge) {
      for (const pt of edge["points"] as number[][]) for (const v of pt) items.push(pyRound4Str(v))
    } else {
      items.push("0", "0", "0")
    }
  }
  return "gedge_" + sha256Hex(items.join("|")).slice(0, 16)
}

/** "gvertex_<hash>". */
export function vertexGeometryHash(pt: number[]): string {
  return "gvertex_" + sha256Hex(pt.map(pyRound4Str).join("|")).slice(0, 16)
}

// Fraction of a half-extent a representative point must clear, on an axis, to
// count as "on that side" of the body. Matches geom_hash._CLASSIFIER_REL.
const CLASSIFIER_REL = 0.5

/** Cardinal/axial classifier tokens ("cls_zp", "cls_xn", ...) for a point. */
export function geometryClassifiers(
  point: number[],
  center: number[],
  halfExtents: number[],
  rel: number = CLASSIFIER_REL,
): string[] {
  const tokens: string[] = []
  const names = "xyz"
  for (let axis = 0; axis < 3; axis++) {
    const h = halfExtents[axis]
    if (h <= 1e-9) continue
    const offset = point[axis] - center[axis]
    if (offset > rel * h) tokens.push("cls_" + names[axis] + "p")
    else if (offset < -rel * h) tokens.push("cls_" + names[axis] + "n")
  }
  return tokens
}
