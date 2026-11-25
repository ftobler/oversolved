// @vitest-environment node
// Two guards for the two halves of the dead-button bug: a bare executeCommand
// whose Result is thrown away, and a native structuredClone handed to a History
// as a value (Node ignores its receiver, Chrome does not).
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '..', '..')

describe('assembly command result plumbing', () => {
  it('routes every executeCommand in AssemblyEditor through the one reporting helper', () => {
    const source = liveText(join(SRC, 'pages', 'AssemblyEditor.tsx'))
    const calls = source.match(/\bexecuteCommand\s*\(/g) ?? []
    // Only the body of runCommand may dispatch; a handler calling it directly
    // would drop a failed Result and leave the tree looking dead again.
    expect(calls).toHaveLength(1)
  })

  it('never passes the bare global structuredClone as a cloner', () => {
    const offenders = productionFiles(SRC)
      .filter(file => /\bcloneDoc\s*:\s*structuredClone\b/.test(liveText(file)))
      .map(file => file.replace(SRC + '/', ''))
    expect(offenders).toEqual([])
  })
})
