#!/usr/bin/env node
// Production/test line report for the core/UI split. It is information, never a
// gate: run it by hand or in CI to see which side is growing.
//
// The classification is a pure function over a path list, so the test can pin it
// against a fixture without touching the tree. `git ls-files` supplies the paths
// and the file bytes supply the counts.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The folders that must run headless in node. Keeping this list here, next to
// the eslint fence's own list, makes a new core folder a deliberate edit rather
// than an accident.
export const CORE_PREFIXES = [
  'frontend/src/kernel/',
  'frontend/src/drive/',
  'frontend/src/session/',
  'frontend/src/persistence/',
  'frontend/src/registry/',
  'frontend/src/workspace/',
  'frontend/src/wasm-kernel/',
  'frontend/src/types/',
  'frontend/src/utils/core/',
  'frontend/src/utils/query/',
  'frontend/src/utils/measure/',
  'frontend/src/utils/yamlMutations/',
  'frontend/src/utils/geometry/',
]

export const RUST_PREFIXES = ['sketch-solver/', 'mate-solver/', 'solver-core/']

const TS_RE = /\.(ts|tsx)$/
const TEST_PATH_RE = /(?:^|\/)__tests__(?:\/|$)|\.test\.(?:ts|tsx)$/

export function isTestPath(path) {
  return TEST_PATH_RE.test(path)
}

export function classifyPath(path) {
  if (RUST_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return path.endsWith('.rs') ? 'rust' : 'other'
  }
  if (!TS_RE.test(path)) return 'other'
  return CORE_PREFIXES.some(prefix => path.startsWith(prefix)) ? 'core' : 'ui'
}

export function summarize(paths, lineCount) {
  const out = {
    core: { prod: 0, test: 0, files: 0 },
    ui: { prod: 0, test: 0, files: 0 },
    rust: { prod: 0, test: 0, files: 0 },
    other: { prod: 0, test: 0, files: 0 },
  }
  for (const path of paths) {
    const side = classifyPath(path)
    const lines = lineCount(path)
    if (isTestPath(path)) out[side].test += lines
    else {
      out[side].prod += lines
      out[side].files += 1
    }
  }
  return out
}

export function countLines(path) {
  const text = readFileSync(path, 'utf8')
  if (text === '') return 0
  // A trailing newline is a terminator, not an extra empty line.
  const newlines = text.split('\n').length - 1
  return text.endsWith('\n') ? newlines : newlines + 1
}

export function collectTracked(root) {
  return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

export function formatReport(summary) {
  const row = (label, value) =>
    `${label.padEnd(10)} prod ${String(value.prod).padStart(8)}  test ${String(value.test).padStart(7)}  files ${String(value.files).padStart(5)}`
  return [
    row('core TS', summary.core),
    row('UI TS', summary.ui),
    row('Rust', summary.rust),
    row('other', summary.other),
  ].join('\n')
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = collectTracked(repoRoot).filter(path =>
    (TS_RE.test(path) && path.startsWith('frontend/src/')) || path.endsWith('.rs'))
  console.log(formatReport(summarize(tracked, path => countLines(resolve(repoRoot, path)))))
}
