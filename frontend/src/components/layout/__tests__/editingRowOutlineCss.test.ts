// jsdom applies no stylesheet, so the outline that wins on an edited row is
// resolved from the rule text. Part.css owns the shared row rules and
// Assembly.css is layered on top in the assembly editor, so both scopes must
// agree: an edited row reads as editing, not as the selected blue line.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')
const ASSEMBLY_CSS = readFileSync(join(__dirname, '../../../pages/Assembly.css'), 'utf8')

interface RowRule {
  selector: string
  outline: string | undefined
  order: number
}

// Only flat class-compound rules are read: the row's outline is never set
// through an ancestor selector or an interaction pseudo-class, so neither can
// change the resting look this resolver asks about.
function rowRules(css: string): RowRule[] {
  const styles = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: RowRule[] = []
  let order = 0
  for (const match of styles.matchAll(/(?:^|\n)[ \t]*([^{}\n][^{}]*?)[ \t]*\{([^}]*)\}/g)) {
    const selector = match[1].trim()
    if (selector.startsWith('@') || selector.includes('{')) continue
    order += 1
    const outline = /(?:^|;)\s*outline\s*:\s*([^;}]+)/.exec(match[2])?.[1]?.trim()
    rules.push({ selector, outline, order })
  }
  return rules
}

function outlineFor(css: string, classes: readonly string[]): string | undefined {
  const subject = new Set(classes)
  let winner: { value: string; specificity: number; order: number } | undefined
  for (const rule of rowRules(css)) {
    if (rule.outline === undefined) continue
    for (const group of rule.selector.split(',')) {
      // A scoped rule names ancestors too (.assembly-panel .feature-item...),
      // so every compound is matched against the row and its ancestors.
      const compounds = group.trim().split(/\s+/).map(compound => {
        const tokens = compound.match(/\.[A-Za-z0-9_-]+|::?[A-Za-z-]+(?:\([^()]*\))?/g) ?? []
        return {
          names: tokens.filter(token => token.startsWith('.')).map(name => name.slice(1)),
          pseudo: tokens.some(token => token.startsWith(':')),
        }
      })
      // State pseudo-classes are interaction looks, not the resting outline.
      if (compounds.some(part => part.pseudo || part.names.length === 0)) continue
      if (!compounds.every(part => part.names.every(name => subject.has(name)))) continue
      const specificity = compounds.reduce((total, part) => total + part.names.length, 0)
      if (
        winner === undefined
        || specificity > winner.specificity
        || (specificity === winner.specificity && rule.order > winner.order)
      ) {
        winner = { value: rule.outline, specificity, order: rule.order }
      }
    }
  }
  return winner?.value
}

// The assembly cards scope some rules to their own ancestor classes. Include
// those ancestors so a sheet-local outline override cannot hide behind them.
const ASSEMBLY_ROW = [
  'feature-item', 'selected', 'editing', 'document-panel', 'assembly-panel', 'features-list',
]

describe('edited row outline', () => {
  it('drops the selected outline on an edited row in both editor scopes', () => {
    for (const css of [PART_CSS, `${PART_CSS}\n${ASSEMBLY_CSS}`]) {
      expect(outlineFor(css, ASSEMBLY_ROW), 'selected editing').toBe('none')
      expect(outlineFor(css, [...ASSEMBLY_ROW, 'related']), 'related selected editing').toBe('none')
    }
  })

  it('keeps the outline on a row that is only selected', () => {
    expect(outlineFor(PART_CSS, ['feature-item', 'selected'])).toBe('1px solid #1e3a4a')
  })

  it('lets the assembly sheet add no outline back', () => {
    expect(outlineFor(ASSEMBLY_CSS, ASSEMBLY_ROW)).toBeUndefined()
  })

  it('drops the pointer focus ring only where no selected outline is drawn', () => {
    const pointerFocus = PART_CSS.match(/\.feature-item:not\(\.selected\):focus:not\(:focus-visible\)\s*\{([^}]*)\}/)
    expect(pointerFocus).not.toBeNull()
    expect(pointerFocus![1]).toMatch(/(?:^|;)\s*outline\s*:\s*none\s*;/)
    expect(PART_CSS).not.toMatch(/\.feature-item:focus\s*\{/)
    // An unscoped guard would also strip the outline of a row the click just
    // selected, so that form must not come back.
    expect(PART_CSS).not.toMatch(/\.feature-item:focus:not\(:focus-visible\)/)
  })
})
