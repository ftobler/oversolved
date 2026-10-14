import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractCommandTable, renderCommandTable, replaceCommandTable } from '@/pages/registry/commandRows'

// The docs command table is generated from the spec tables and checked in, the
// way the license bundles are: a spec change that is not regenerated fails here
// with the diff. Regenerate with `npm run docs:commands` (this same file run
// with UPDATE_COMMAND_DOCS=1 writes the block instead of only checking it).
const DOCS_PATH = join(__dirname, '../../../../../docs/command_system.md')
const UPDATE = process.env.UPDATE_COMMAND_DOCS === '1'

describe('docs/command_system.md command table', () => {
  const docs = readFileSync(DOCS_PATH, 'utf8')

  it('contains the marker-delimited command table', () => {
    expect(extractCommandTable(docs)).not.toBeNull()
  })

  it('matches the rendered table from the spec tables', () => {
    const rendered = renderCommandTable()
    if (UPDATE) {
      const next = replaceCommandTable(docs, rendered)
      if (next !== null && next !== docs) writeFileSync(DOCS_PATH, next)
      expect(extractCommandTable(readFileSync(DOCS_PATH, 'utf8'))).toBe(rendered)
      return
    }
    expect(extractCommandTable(docs)).toBe(rendered)
  })
})
