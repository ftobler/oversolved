/**
 * The app must run under any deploy base, not only at `/`. GitHub Pages serves
 * it as a project page under `/oversolved/`, so a string literal such as
 * `'/occ/'` or `'/env.hdr'` would fetch from the host root and 404 there while
 * still passing locally. Public assets are reached through
 * `import.meta.env.BASE_URL` instead.
 *
 * A source-text scan, same shape as importBoundary.test.ts. The names to look
 * for come from the `public/` listing, so a newly added public asset is covered
 * without touching this file. Test files are skipped: the rule is about what
 * ships.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const SRC = join(__dirname, '..')
const PUBLIC = join(SRC, '..', 'public')

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(?:^|\s)\/\/[^\n]*/g

// Blank out comments while preserving line count, so a doc comment saying
// "served under /occ/" cannot fail the scan.
function stripComments(text: string): string {
  return text
    .replace(BLOCK_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
    .replace(LINE_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(path))
    } else if (['.ts', '.tsx'].includes(extname(name)) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('deploy base', () => {
  it('no shipped source names a public asset by a root-absolute path', () => {
    const entries = readdirSync(PUBLIC)
    expect(entries).toContain('env.hdr')  // the listing is what the scan keys on
    // A quote or backtick, then `/` and a top-level public entry name.
    const rootAbsolute = new RegExp(`["'\`]/(?:${entries.map(escape).join('|')})(?![\\w.-])`)

    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (rootAbsolute.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
