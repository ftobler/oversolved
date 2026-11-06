import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { basename, join } from 'path'

// `new oc.Handle_X(raw)` adopts `raw` into OCC's refcount, so the Handle and
// whatever is built from it (an edge, a face) own it from then on. A
// DisposeScope that also tracks `raw` deletes it at dispose with no regard for
// that refcount, freeing it under every shape that still references it. That
// was the fuzz-session seed 33 heap corruption (curveOwnershipReal.test.ts
// proves the trap per producer); this scan keeps the pattern out of the whole
// source tree, tests included, since a test that frees under a live edge can
// corrupt the heap its vitest worker shares with every later Real test.
const SRC = join(__dirname, '../../..')
// This file spells the bug out in its own self-test strings.
const SELF = basename(__filename)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...sourceFiles(p))
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && entry.name !== SELF) {
      out.push(p)
    }
  }
  return out
}

/** Objects a Handle constructor adopts while a scope also tracks them: a named
 *  argument tracked elsewhere in the file, or a `.track(...)` call passed
 *  straight in. The module is `oc` in the kernel and `occ` in most tests. */
function trackedAdoptees(src: string): string[] {
  const offenders: string[] = []
  for (const match of src.matchAll(/new occ?\.Handle_\w+\(\s*(\w+)\s*\)/g)) {
    const name = match[1]
    const tracked = new RegExp(`\\b${name}\\s*=\\s*\\w+\\.track\\(|\\.track\\(\\s*${name}\\s*\\)`)
    if (tracked.test(src)) offenders.push(name)
  }
  for (const match of src.matchAll(/new occ?\.Handle_\w+\(\s*\w+\.track\(/g)) {
    offenders.push(match[0])
  }
  return offenders
}

describe('a raw OCC object adopted by a Handle is never scope-tracked', () => {
  it('the scan catches the shapes of the seed 33 bug', () => {
    const bug = [
      'const bez = scope.track(new oc.Geom_BezierCurve_1(arr))',
      'const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(bez))',
    ].join('\n')
    expect(trackedAdoptees(bug)).toEqual(['bez'])
    const inline = 'return new occ.Handle_Geom_Curve_2(scope.track(new occ.Geom_BezierCurve_1(arr)))'
    expect(trackedAdoptees(inline)).toHaveLength(1)
    const fixed = [
      'const bez = new oc.Geom_BezierCurve_1(arr)',
      'const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(bez))',
      'return new occ.Handle_Geom_Curve_2(new occ.Geom_BezierCurve_1(arr))',
    ].join('\n')
    expect(trackedAdoptees(fixed)).toEqual([])
  })

  it('no source file tracks an object it hands to a Handle', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      for (const name of trackedAdoptees(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(SRC, 'src')}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
