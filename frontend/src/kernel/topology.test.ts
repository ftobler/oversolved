import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/topology.json"
import { detectTopology } from "./topology"

// Structure and identity-bearing query strings must match Python exactly;
// coordinates are compared within a tight tolerance to absorb cross-language
// transcendental last-bit differences (atan2/sin/cos/hypot). A mismatch reports
// the JSON path so divergence is easy to localize.
const TOL = 1e-9

function assertDeepClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, `${path}: type`).toBe("number")
    const a = actual as number
    if (Number.isNaN(expected)) {
      expect(Number.isNaN(a), `${path}`).toBe(true)
      return
    }
    const diff = Math.abs(a - expected)
    const ok = diff <= TOL || diff <= TOL * Math.abs(expected)
    expect(ok, `${path}: ${a} != ${expected} (diff ${diff})`).toBe(true)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: expected array`).toBe(true)
    const arr = actual as unknown[]
    expect(arr.length, `${path}: length`).toBe(expected.length)
    expected.forEach((v, i) => assertDeepClose(arr[i], v, `${path}[${i}]`))
    return
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", `${path}: expected object`).toBe(true)
    const eObj = expected as Record<string, unknown>
    const aObj = actual as Record<string, unknown>
    expect(Object.keys(aObj).sort(), `${path}: keys`).toEqual(Object.keys(eObj).sort())
    for (const k of Object.keys(eObj)) assertDeepClose(aObj[k], eObj[k], `${path}.${k}`)
    return
  }
  // string | boolean | null: exact (queries, kinds, vertex ids, classifiers)
  expect(actual, `${path}`).toBe(expected)
}

describe("detectTopology parity with Python", () => {
  for (const [name, c] of Object.entries(fixture)) {
    it(name, () => {
      const result = detectTopology(
        c.geometry as Record<string, unknown>,
        c.feature_id as string,
      )
      assertDeepClose(result, c.expected, name)
    })
  }
})
