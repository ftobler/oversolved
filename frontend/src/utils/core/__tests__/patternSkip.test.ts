// Skip Instances: one parser for the editor, the drive and the kernel. The
// token rules are the user's page-selector contract: integers only, a `-` is a
// reverse-side sign rather than a range, and instance 0 is the original.
import { describe, it, expect } from 'vitest'
import {
  canonicalSkip,
  formatSkipList,
  parseSkipList,
  skipEntryKey,
  skipProblem,
  skipValue,
} from '../patternSkip'

function parsed(text: string): unknown {
  const result = parseSkipList(text)
  return result.ok ? result.skip : result.error
}

describe('parseSkipList', () => {
  it('reads the printer-style list', () => {
    expect(parsed('1,2,6,7')).toEqual([1, 2, 6, 7])
    expect(parsed(' 1 2  6,7 ')).toEqual([1, 2, 6, 7])
  })

  it('reads a negative index and a grid cell', () => {
    expect(parsed('-1, 3')).toEqual([-1, 3])
    expect(parsed('2:-1')).toEqual([[2, -1]])
    // A bare integer is the cell's column 0 row.
    expect(parsed('2, 2:0')).toEqual([2])
  })

  it('reads empty text as the empty list', () => {
    expect(parsed('')).toEqual([])
    expect(parsed('   ')).toEqual([])
  })

  it('refuses the original and duplicates collapse', () => {
    expect(parsed('0')).toContain('instance 0 is the original')
    expect(parsed('0:0')).toContain('is the original')
    expect(parsed('2, 2:0, 2')).toEqual([2])
  })

  it('refuses a range, naming the token and the fix', () => {
    const message = parsed('3-5')
    expect(typeof message).toBe('string')
    expect(message).toContain('"3-5"')
    expect(message).toContain('ranges are not supported')
  })

  it('refuses a non-integer and an unknown character', () => {
    expect(parsed('1.5')).toContain('whole instance number')
    expect(parsed('a')).toContain('is not an instance number')
    expect(parsed('1:')).toContain('is not a cell')
  })
})

describe('formatSkipList', () => {
  it('writes the canonical spelling back to the field', () => {
    expect(formatSkipList([7, 6, 2, 1, 2])).toEqual('1, 2, 6, 7')
    expect(formatSkipList([[2, -1], 1])).toEqual('1, 2:-1')
    expect(formatSkipList(undefined)).toEqual('')
  })

  it('round-trips the parser output', () => {
    for (const text of ['1, 2, 6, 7', '-1, 3', '2:-1', '']) {
      const result = parseSkipList(text)
      expect(result.ok, text).toBe(true)
      if (!result.ok) continue
      expect(formatSkipList(result.skip)).toBe(text)
    }
  })
})

describe('skipProblem and skipValue', () => {
  it('accepts a stored list of indices and cells', () => {
    expect(skipProblem([1, -1, [2, -1]])).toBeNull()
    expect(skipProblem([])).toBeNull()
  })

  it('refuses the original, a non-integer and a malformed cell', () => {
    expect(skipProblem([0])).toContain('original')
    expect(skipProblem([[0, 0]])).toContain('original')
    expect(skipProblem([1.5])).toContain('whole instance number')
    expect(skipProblem([[1]])).toContain('[column, row]')
    expect(skipProblem('1, 2')).toContain('list of instance numbers')
  })

  it('canonicalises either accepted mutation spelling', () => {
    expect(skipValue('3, 1, 3')).toEqual({ skip: [1, 3] })
    expect(skipValue([3, 1])).toEqual({ skip: [1, 3] })
    expect(skipValue('0')).toEqual({ error: expect.stringContaining('original') })
    expect(skipValue([0])).toEqual({ error: expect.stringContaining('original') })
  })

  it('canonicalises and keys entries', () => {
    expect(canonicalSkip([1, [1, 0], [0, 1]])).toEqual([[0, 1], 1])
    expect(skipEntryKey(-2)).toBe('-2')
    expect(skipEntryKey([2, -1])).toBe('2:-1')
  })
})
