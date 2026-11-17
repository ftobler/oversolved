// One vocabulary for units, and one place that renders it. A number box that
// hand-builds its own suffix is how the circular pattern's "deg" ended up in a
// larger font than its neighbours and eating the row's width. So:
// - `field-unit` (the adornment class) is written by UnitLabel.tsx alone;
// - no .tsx writes a bare unit token as JSX text, and no JSX label carries its
//   own unit suffix ("Taper (deg)", "Rot.°"). The unit belongs to the box.
//
// A button may still read "+90°": an increment's label is prose, not a field's
// unit, and it is not a lone unit token.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const COMPONENTS = join(__dirname, '..')
const UNIT_LABEL_COMPONENT = 'editors/widgets/UnitLabel.tsx'

function componentSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path)
    }
  }
  walk(COMPONENTS)
  return out
}

/** Comments state the rule; they are not UI, so they cannot hand-build a unit. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const path of componentSources()) {
    const name = relative(COMPONENTS, path).split(/[\\/]/).join('/')
    const source = stripComments(readFileSync(path, 'utf8'))
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      if (pattern.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

describe('units are one component, not hand-built spans', () => {
  it('writes the field-unit class only in UnitLabel.tsx', () => {
    const found = componentSources()
      .map(path => ({ path, name: relative(COMPONENTS, path).split(/[\\/]/).join('/') }))
      .filter(({ name }) => name !== UNIT_LABEL_COMPONENT)
      .map(({ path, name }) => ({ name, source: stripComments(readFileSync(path, 'utf8')) }))
      .filter(({ source }) => /['"`][^'"`]*field-unit/.test(source))
      .map(({ name }) => name)
    expect(found).toEqual([])
  })

  it('writes no bare unit token as JSX text', () => {
    // `>deg<`, `>mm<`, `>&deg;<`: the hand-built adornment of the old bug.
    expect(offenders(/>\s*(mm|deg|pcs|in|&deg;|°)\s*</)).toEqual([])
  })

  it('writes no unit suffix into a label', () => {
    // "Taper (deg)", "Rot.°": the label says what the value is, the box says
    // what it measures. A `+90°` button text does not start with a letter, so
    // it stays allowed.
    expect(offenders(/>\s*[A-Za-z][^<>{}]*(\s\((deg|mm|in|pcs)\)|&deg;|°)\s*</)).toEqual([])
  })
})
