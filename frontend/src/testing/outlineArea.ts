// Exact signed area of closed line / cubic Bezier outlines, for the text tests.
// Green's theorem, A = 1/2 * integral of (x dy - y dx), integrated per segment
// on the polynomial coefficients rather than by sampling, so the expected value
// is exact for the stored geometry and a kernel volume can be held to a
// relative tolerance near float precision.

type Poly = number[]  // coefficients, lowest power first

function bezierPoly(p0: number, p1: number, p2: number, p3: number): Poly {
  return [p0, 3 * (p1 - p0), 3 * (p0 - 2 * p1 + p2), -p0 + 3 * p1 - 3 * p2 + p3]
}

function derivative(p: Poly): Poly {
  return p.slice(1).map((c, i) => c * (i + 1))
}

function multiply(a: Poly, b: Poly): Poly {
  const out = new Array(a.length + b.length - 1).fill(0)
  a.forEach((ca, i) => b.forEach((cb, j) => { out[i + j] += ca * cb }))
  return out
}

function integrateUnit(p: Poly): number {
  return p.reduce((sum, c, i) => sum + c / (i + 1), 0)
}

/** Twice the signed area swept by one segment, from the flat params of a sketch
 *  `line` ([x1, y1, x2, y2]) or `spline` ([x1, y1, c1x, c1y, c2x, c2y, x2, y2]). */
export function segmentDoubleArea(kind: string, params: readonly number[]): number {
  if (kind === 'line') {
    const [x0, y0, x1, y1] = params
    return x0 * y1 - x1 * y0
  }
  if (kind !== 'spline') throw new Error(`segmentDoubleArea: unsupported kind ${kind}`)
  const x = bezierPoly(params[0], params[2], params[4], params[6])
  const y = bezierPoly(params[1], params[3], params[5], params[7])
  const xdy = multiply(x, derivative(y))
  const ydx = multiply(y, derivative(x))
  return integrateUnit(xdy) - integrateUnit(ydx)
}

/** The signed area of every segment together. For glyph outlines (outer and
 *  counter contours wound oppositely, none overlapping) its magnitude is the
 *  filled even-odd area. */
export function outlineSignedArea(rows: ReadonlyArray<{ kind: string; params: readonly number[] }>): number {
  return rows.reduce((sum, row) => sum + segmentDoubleArea(row.kind, row.params), 0) / 2
}
