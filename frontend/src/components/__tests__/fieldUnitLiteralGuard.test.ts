// One vocabulary for units, and one place that renders it. A number box that
// hand-builds its own suffix is how the circular pattern's "deg" ended up in a
// larger font than its neighbours and eating the row's width. So:
// - `field-unit` (the adornment class) is written by UnitLabel.tsx alone;
// - no .tsx writes a bare unit token as JSX text or as a `{'deg'}` expression;
// - no JSX label carries its own unit suffix ("Taper (deg)", "Rot.°"), and no
//   `label:`/`label=` string ends in one. The unit belongs to the box.
//
// Deliberate allowances, none of them a field's unit:
// - a `+90°` button text (an increment's label, and not a lone unit token);
// - canvas read-outs built as template strings and assigned (`const label =
//   \`${value}°\` in the dimension components, `utils/angleDialGeometry.ts`,
//   `labelFont.ts`'s font warm-up string), which never sit next to an input;
// - the `--field-unit-slot` custom property (the slot width), not a class;
// - prose outside components (measurement table rows, comments).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const COMPONENTS = join(__dirname, '..')
const UNIT_LABEL_COMPONENT = 'editors/widgets/UnitLabel.tsx'

/** A `label:` object key or a JSX `label=` attribute whose string carries its
 *  own unit suffix. Fresh each call, so a global match cannot carry state. */
const labelPropPattern = () =>
  /\blabel(?::\s*|=\s*)['"`][^'"`]*(\s\((deg|mm|in|pcs)\)|&deg;|°)[^'"`]*['"`]/g

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

/** Every match of a source pattern, with its 1-based line. The patterns run
 *  over the whole source so a unit on its own line is caught too. */
function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const path of componentSources()) {
    const name = relative(COMPONENTS, path).split(/[\\/]/).join('/')
    const source = stripComments(readFileSync(path, 'utf8'))
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(`${name}:${line}: ${match[0].replace(/\s+/g, ' ').trim()}`)
    }
  }
  return found
}

describe('units are one component, not hand-built spans', () => {
  it('writes the field-unit class only in UnitLabel.tsx', () => {
    const found = componentSources()
      .map(path => ({ path, name: relative(COMPONENTS, path).split(/[\\/]/).join('/') }))
      .filter(({ name }) => name !== UNIT_LABEL_COMPONENT)
      .map(({ path, name }) => ({ name, source: stripComments(readFileSync(path, 'utf8')) }))
      .filter(({ source }) => /['"`][^'"`]*(?<!-)field-unit/.test(source))
      .map(({ name }) => name)
    expect(found).toEqual([])
  })

  it('writes no bare unit token as JSX text', () => {
    // `>deg<`, `>mm<`, `>&deg;<`: the hand-built adornment of the old bug.
    expect(offenders(/>\s*(mm|deg|pcs|in|&deg;|°)\s*</g)).toEqual([])
  })

  it('writes no unit token as a JSX expression beside a box', () => {
    // `{'deg'}`, `{"mm"}`: the same hand-built suffix, spelled as an expression
    // so the JSX-text scan cannot see it.
    expect(offenders(/\{\s*['"`](mm|deg|pcs|in|&deg;|°)['"`]\s*\}/g)).toEqual([])
  })

  it('writes no unit suffix into a JSX label', () => {
    // "Taper (deg)", "Rot.°": the label says what the value is, the box says
    // what it measures. A `+90°` button text does not start with a letter, so
    // it stays allowed.
    expect(offenders(/>\s*[A-Za-z][^\n<>{}]*(\s\((deg|mm|in|pcs)\)|&deg;|°)\s*</g)).toEqual([])
  })

  it('writes no unit suffix into a label prop string', () => {
    // A schema-style `label: 'Taper (deg)'` or a JSX `label="Angle (deg)"` is
    // the same mistake one level away from the JSX text the rule above sees.
    // `const label = \`${value}°\`` (a canvas read-out) is not a prop.
    expect(offenders(labelPropPattern())).toEqual([])
  })

  it('the label rule catches the shape it bans', () => {
    // A positive control: the allowance for an assigned canvas read-out must not
    // have blunted the rule for a real prop string.
    expect("label: 'Taper (deg)'".match(labelPropPattern())).not.toBeNull()
    expect('label="Angle (mm)"'.match(labelPropPattern())).not.toBeNull()
    expect('const label = `${value}°`'.match(labelPropPattern())).toBeNull()
  })
})
