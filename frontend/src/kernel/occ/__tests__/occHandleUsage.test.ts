// Every temporary OCC object is owned the moment it exists. Two shapes shipped
// leaks into the move-face and helix leaves:
//   1. `scope.track(new oc.Builder(...).Face())` tracks the FACE but not the
//      builder that made it. Wrapping the expression in track() cannot cover
//      both proxies, so a constructor chained straight into Face()/Shape() is
//      always one untracked object.
//   2. `cyl.Axis().Direction()` chains two by-value `gp_*` accessors, each of
//      which returns a fresh proxy owning WASM memory. Tracking the outer
//      result (the shape shipped did) still leaks the inner one.
//
// This is a lint-shaped source scan like the other scans in this suite: it
// strips comments (prose must not trip it) and reads the live source only. It
// cannot follow a shape through a helper, so the accessor rule is limited to
// the double chain it can see; the ownership comment in
// occ/moveFaceSurfaces.ts's take* readers carries the rest.

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '../../')

// The builders whose result is a shape the caller may chain off the constructor.
const SHAPE_RESULT = /^\s*\.\s*(Face|Shape|Wire|Solid|Edge|Vertex)\s*\(\s*\)/
// The by-value gp_* accessors: each call returns a fresh disposable proxy.
const ACCESSOR =
  /\.(Axis|Position|Location|Direction|XDirection|YDirection|XAxis|YAxis)\(\)\s*\.\s*(Axis|Position|Location|Direction|XDirection|YDirection|XAxis|YAxis)\(\)/g

/** End index (exclusive) of the parenthesised argument list starting at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

/** Offsets of `new oc.X(...)` whose result is chained into a shape accessor.
 *  One of the two proxies in that expression is untracked by construction. */
function untrackedBuilderChains(text: string): number[] {
  const hits: number[] = []
  const ctor = /new\s+oc\.\w+\s*\(/g
  let m: RegExpExecArray | null
  while ((m = ctor.exec(text)) !== null) {
    const open = m.index + m[0].length - 1
    const end = closingParen(text, open)
    if (SHAPE_RESULT.test(text.slice(end))) hits.push(m.index)
  }
  return hits
}

describe('temporary OCC handles are tracked at creation', () => {
  const sources = productionFiles(SRC)

  it('scans a non-empty source tree', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('never chains a shape off an untracked builder', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const text = liveText(file)
      for (const at of untrackedBuilderChains(text)) {
        const line = text.slice(0, at).split('\n').length
        offenders.push(`${file.slice(SRC.length + 1)}:${line} ${text.slice(at, at + 80).split('\n')[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never chains one gp accessor straight into another', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const text = liveText(file)
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(ACCESSOR)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} ${m[0]}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
