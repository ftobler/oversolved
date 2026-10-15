/**
 * Derive the OCC bindings this app actually uses, as the input for a slim
 * opencascade.js build.
 *
 * The shipped 1.1.1 artifact marks over 4000 classes as supported; the kernel
 * touches a few dozen. The slim-build recipe (docs/setup.md) needs that list,
 * and a
 * hand-kept list goes stale the first time someone calls a new class, so the
 * list is derived from the tree: the declared embind surface in
 * src/kernel/occ/occTypes.ts, plus every `oc.` / `occ.` access in src/ (tests
 * included: the gated Real suites run against the same artifact). The result
 * is written to frontend/occ.used.json and `--check` fails when the two drift,
 * so a slim build cannot silently lose a binding the code gained.
 *
 * Usage:
 *   node scripts/occUsage.mjs               # write occ.used.json
 *   node scripts/occUsage.mjs --check       # fail when occ.used.json is stale
 *   node scripts/occUsage.mjs symbols       # one symbol per line (build allowlist)
 *
 * --src DIR and --out FILE retarget the scan and the file, so the tests can
 * drive fixture trees the way occProvision.mjs does.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The receivers the tree uses for the OCC module. `occ` doubles as the
// memoized loader in loadOcc.ts, which is why properties below the OCC naming
// rule are dropped rather than trusted blindly.
const RECEIVER = String.raw`(?<![\w$.])(?:oc|occ|occModule)\.([A-Za-z_$][A-Za-z0-9_$]*)`

// Emscripten runtime members, not OCCT classes: they come from the build's
// exported-runtime-methods/functions flags and cannot be expressed as a
// binding. They still count as used, so they are recorded, in their own list.
const RUNTIME_MEMBERS = ['FS', 'HEAP32', 'UTF8ToString', '___getTypeName', '_free']

// A binding name is everything OCCT names: at least one uppercase letter.
// This is what keeps `occ.load` (the memoized loader's method) and stray
// `occ.pin` matches out; every OCCT class, enum and function qualifies.
function looksLikeOcctName(name) {
  return /[A-Z]/.test(name)
}

function stripSuffix(digits) {
  return digits.replace(/_\d+$/, '')
}

/**
 * The top-level members of the two module interfaces in occTypes.ts. They are
 * what the kernel declares it touches, so they belong in the list even when a
 * current code path does not reach every one of them.
 */
export function declaredSymbols(occTypesSource) {
  const out = new Set()
  let inModuleInterface = false
  for (const line of occTypesSource.split('\n')) {
    if (/^export interface Occ(?:Base)?Module\b.*\{$/.test(line)) {
      inModuleInterface = true
      continue
    }
    if (inModuleInterface && line === '}') {
      inModuleInterface = false
      continue
    }
    if (!inModuleInterface) continue
    const member = /^  ([A-Za-z_$][A-Za-z0-9_$]*):/.exec(line)
    if (member) out.add(stripSuffix(member[1]))
  }
  return [...out]
}

/** Comment text must not count as an access; strings keep the naming filter honest. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      const i = line.indexOf('//')
      if (i < 0) return line
      const before = line.slice(0, i)
      if (before.endsWith(':')) return line  // https:// and friends
      const quotes = (before.match(/(?<!\\)['"`]/g) ?? []).length
      if (quotes % 2 === 1) return line  // inside a string literal
      return before
    })
    .join('\n')
}

function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * The full used-binding picture for a source tree. Returns sorted, deduped
 * `symbols` (OCCT bindings, overload suffixes stripped) and `runtime`
 * (emscripten members), plus the file each symbol was seen in for the report.
 */
export function scanUsage(srcDir) {
  const symbols = new Set()
  const runtime = new Set()
  const seenIn = new Map()
  const accessPattern = new RegExp(RECEIVER, 'g')

  const record = (name, file) => {
    const stripped = stripSuffix(name)
    if (!seenIn.has(stripped)) seenIn.set(stripped, new Set())
    seenIn.get(stripped).add(file)
    if (RUNTIME_MEMBERS.includes(stripped)) runtime.add(stripped)
    else if (looksLikeOcctName(stripped)) symbols.add(stripped)
  }

  for (const file of sourceFiles(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/')
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(accessPattern)) record(match[1], rel)
  }

  const occTypes = path.join(srcDir, 'kernel', 'occ', 'occTypes.ts')
  if (existsSync(occTypes)) {
    for (const name of declaredSymbols(readFileSync(occTypes, 'utf8'))) {
      if (RUNTIME_MEMBERS.includes(name)) runtime.add(name)
      else symbols.add(name)
    }
  }

  return {
    symbols: [...symbols].sort(),
    runtime: [...runtime].sort(),
    seenIn,
  }
}

/** The committed shape. Sorted lists, so regeneration is byte-stable. */
export function usageDocument(usage) {
  return JSON.stringify({
    _comment:
      'Generated by scripts/occUsage.mjs from src/kernel/occ/occTypes.ts and every oc./occ. access in src/; ' +
      'the input for the slim opencascade.js build recipe in docs/setup.md. Regenerate with npm run occ:usage. ' +
      'symbols: OCCT bindings, overload suffixes stripped. runtime: emscripten members from build flags (must stay in them).',
    symbols: usage.symbols,
    runtime: usage.runtime,
  }, null, 2) + '\n'
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') {
      flags.check = true
      continue
    }
    if (argv[i].startsWith('--')) {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        flags[argv[i].slice(2)] = value
        i++
      } else {
        flags[argv[i].slice(2)] = true
      }
    }
  }
  return flags
}

function describeDrift(committed, usage) {
  const lines = []
  const missing = usage.symbols.filter(s => !committed.symbols.includes(s))
  const stale = committed.symbols.filter(s => !usage.symbols.includes(s))
  const runtimeDrift = [
    ...usage.runtime.filter(s => !committed.runtime.includes(s)),
    ...committed.runtime.filter(s => !usage.runtime.includes(s)),
  ]
  for (const s of missing) {
    const files = usage.seenIn.get(s)
    lines.push(`used but missing from occ.used.json: ${s}${files ? ` (${[...files].join(', ')})` : ''}`)
  }
  for (const s of stale) lines.push(`listed but no longer used: ${s}`)
  for (const s of runtimeDrift) lines.push(`runtime member classification changed: ${s}`)
  return lines
}

function main() {
  const argv = process.argv.slice(2)
  const flags = parseArgs(argv)
  // A positional word (generate|check|symbols) is the command; `--check` and
  // bare invocations both land on the two obvious readings.
  const positionals = argv.filter(
    (arg, i) => !arg.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')),
  )
  const command = flags.check ? 'check' : (positionals[0] ?? 'generate')
  const srcDir = path.resolve(flags.src ?? path.join(FRONTEND_DIR, 'src'))
  const outPath = path.resolve(flags.out ?? path.join(FRONTEND_DIR, 'occ.used.json'))

  const usage = scanUsage(srcDir)
  if (command === 'symbols') {
    for (const symbol of usage.symbols) console.log(symbol)
    return
  }

  const fresh = usageDocument(usage)
  if (command === 'generate') {
    writeFileSync(outPath, fresh)
    console.log(`wrote ${path.relative(FRONTEND_DIR, outPath)} (${usage.symbols.length} bindings, ${usage.runtime.length} runtime members, scanned ${path.relative(FRONTEND_DIR, srcDir)})`)
    return
  }
  if (command === 'check') {
    if (!existsSync(outPath)) {
      console.error(`${outPath} is missing: run npm run occ:usage`)
      process.exit(1)
    }
    const committed = JSON.parse(readFileSync(outPath, 'utf8'))
    const drift = describeDrift(committed, usage)
    if (drift.length > 0) {
      console.error('occ.used.json is stale against the source tree:')
      for (const line of drift) console.error(`  - ${line}`)
      console.error('Regenerate with npm run occ:usage and commit the result.')
      process.exit(1)
    }
    return
  }
  console.error('usage: node scripts/occUsage.mjs [generate|check|symbols] [--src DIR] [--out FILE]')
  process.exit(2)
}

// Importing the module for its pure helpers (the vitest suite) must not run
// the CLI. Only a direct invocation parses argv.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
