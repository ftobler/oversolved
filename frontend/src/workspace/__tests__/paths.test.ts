// The workspace tree must never expose app bookkeeping as an entry: the folder
// layout reserves `.oversolved-*` for its own files, and every path that names
// one has to be refused before it is written or read. These pin the path
// primitives shared by the folder and zip carriers.
import { describe, it, expect } from 'vitest'
import {
  MANIFEST_PATH,
  DOCUMENTS_DIR,
  FILES_DIR,
  dirOf,
  isReservedPath,
  kindDir,
  pathFor,
  assertPathFree,
} from '../paths'
import { UNTITLED_DOC_NAME } from '@/stores/documentStore/secureFilename'

describe('isReservedPath', () => {
  it('lets the manifest through: it is the one reserved name the tree holds', () => {
    expect(isReservedPath(MANIFEST_PATH)).toBe(false)
  })

  it('rejects a reserved segment at any depth', () => {
    expect(isReservedPath('documents/.oversolved-index.json')).toBe(true)
    expect(isReservedPath('.oversolved-trash/x')).toBe(true)
    expect(isReservedPath('documents/sub/.oversolved-index.json')).toBe(true)
  })

  it('accepts an ordinary name that merely contains the reserved text', () => {
    expect(isReservedPath('documents/a.oversolved-b.yaml')).toBe(false)
    expect(isReservedPath('files/not-.oversolved-x.step')).toBe(false)
  })
})

describe('assertPathFree', () => {
  it('refuses a reserved path before a taken one', () => {
    // Both conditions hold: the reserved error must win, since reservation is
    // about identity, not occupancy.
    expect(() => assertPathFree('documents/.oversolved-index.json', () => true))
      .toThrow(/reserved/)
  })

  it('refuses a taken but unreserved path', () => {
    expect(() => assertPathFree('documents/A.yaml', p => p === 'documents/A.yaml'))
      .toThrow(/already in use/)
  })

  it('allows a free, unreserved path', () => {
    expect(() => assertPathFree('documents/A.yaml', () => false)).not.toThrow()
  })
})

describe('pathFor', () => {
  const free = () => false

  it('puts a document under documents/ with a yaml extension', () => {
    expect(pathFor('document', 'Bracket', free)).toBe('documents/Bracket.yaml')
  })

  it('puts a file under files/ with no extension added', () => {
    expect(pathFor('file', 'Bracket.step', free)).toBe('files/Bracket.step')
  })

  it('appends the collision suffix through the taken predicate', () => {
    expect(pathFor('document', 'A', p => p === 'documents/A.yaml')).toBe('documents/A_1.yaml')
    expect(pathFor('file', 'A.step', p => p === 'files/A.step')).toBe('files/A_1.step')
  })

  it('emits no leading slash when the caller supplies an empty directory', () => {
    expect(pathFor('document', 'A', free, '')).toBe('A.yaml')
    expect(pathFor('file', 'A', free, '')).toBe('A')
  })

  it('tolerates a trailing slash on the directory', () => {
    expect(pathFor('document', 'A', free, 'documents/')).toBe('documents/A.yaml')
  })

  it('falls back to the untitled name for an empty or unnameable name', () => {
    expect(pathFor('document', '', free)).toBe(`documents/${UNTITLED_DOC_NAME}.yaml`)
    expect(pathFor('document', '日本語', free)).toBe(`documents/${UNTITLED_DOC_NAME}.yaml`)
  })

  it('kindDir is the reserved directory per entry kind', () => {
    expect(kindDir('document')).toBe(DOCUMENTS_DIR)
    expect(kindDir('file')).toBe(FILES_DIR)
  })
})

describe('dirOf', () => {
  it('is empty for a top-level name', () => {
    expect(dirOf('A.yaml')).toBe('')
  })

  it('splits a nested path at its last slash', () => {
    expect(dirOf('documents/A.yaml')).toBe('documents')
    expect(dirOf('documents/sub/A.yaml')).toBe('documents/sub')
  })
})
