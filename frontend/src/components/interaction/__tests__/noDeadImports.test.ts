import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

describe('no dead imports', () => {
  it('interaction-actions.ts is deleted', () => {
    expect(existsSync('src/components/interaction/interaction-actions.ts')).toBe(false)
  })

  it('nothing imports from interaction-actions', () => {
    const srcDir = 'src'
    const offenders: string[] = []

    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== 'node_modules') walk(full)
        } else if (/\.([jt]sx?)$/.test(entry)) {
          const content = readFileSync(full, 'utf-8')
          if (
            !full.includes('noDeadImports') &&
            (content.includes("from './interaction-actions'") ||
            content.includes('from "./interaction-actions"') ||
            content.includes("from '../../interaction/interaction-actions'") ||
            content.includes('from "../../interaction/interaction-actions"'))
          ) {
            offenders.push(full)
          }
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})
