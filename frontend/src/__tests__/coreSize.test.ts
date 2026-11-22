// @vitest-environment node
// The report is not a gate, but its classification is: a file counted on the
// core side must actually be one the fence treats as core. The fixture pins the
// folder rules without depending on the tree.
import { describe, it, expect } from 'vitest'
import { classifyPath, isTestPath, summarize } from '../../scripts/coreSize.mjs'

describe('coreSize classification', () => {
  it('counts the core folders as core and the UI folders as UI', () => {
    expect(classifyPath('frontend/src/kernel/builder.ts')).toBe('core')
    expect(classifyPath('frontend/src/session/DocSession.ts')).toBe('core')
    expect(classifyPath('frontend/src/persistence/idb.ts')).toBe('core')
    expect(classifyPath('frontend/src/workspace/store.ts')).toBe('core')
    expect(classifyPath('frontend/src/utils/geometry/dragLogic.ts')).toBe('core')
    expect(classifyPath('frontend/src/components/Viewport/index.tsx')).toBe('ui')
    expect(classifyPath('frontend/src/stores/editorState.ts')).toBe('ui')
    expect(classifyPath('frontend/src/pages/Part.tsx')).toBe('ui')
  })

  it('counts Rust crates separately and ignores non-source files', () => {
    expect(classifyPath('sketch-solver/src/lib.rs')).toBe('rust')
    expect(classifyPath('solver-core/src/lm.rs')).toBe('rust')
    expect(classifyPath('sketch-solver/Cargo.toml')).toBe('other')
    expect(classifyPath('frontend/package.json')).toBe('other')
  })

  it('recognises test paths under both conventions', () => {
    expect(isTestPath('frontend/src/kernel/__tests__/builder.test.ts')).toBe(true)
    expect(isTestPath('frontend/src/stores/sketchEditorStore.test.tsx')).toBe(true)
    expect(isTestPath('frontend/src/kernel/builder.ts')).toBe(false)
  })

  it('splits prod and test lines per side', () => {
    const lines = new Map([
      ['frontend/src/kernel/builder.ts', 100],
      ['frontend/src/kernel/__tests__/builder.test.ts', 10],
      ['frontend/src/components/Foo.tsx', 40],
      ['sketch-solver/src/lib.rs', 7],
      ['README.md', 1000],
    ])
    const summary = summarize([...lines.keys()], path => lines.get(path) ?? 0)
    expect(summary.core).toEqual({ prod: 100, test: 10, files: 1 })
    expect(summary.ui).toEqual({ prod: 40, test: 0, files: 1 })
    expect(summary.rust).toEqual({ prod: 7, test: 0, files: 1 })
    expect(summary.other).toEqual({ prod: 1000, test: 0, files: 1 })
  })
})
