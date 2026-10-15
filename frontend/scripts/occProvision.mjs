/**
 * Verify and provision the pinned OpenCascade artifact.
 *
 * `occ:install` runs `npm i --no-save opencascade.js@<version>`, which npm
 * integrity-checks against the registry; this script then verifies the
 * installed bytes against frontend/occ.pin.json (exact version, OCCT version,
 * per-file sha256) and `occ:provision` copies only verified files into
 * public/occ. Nothing half-verified can reach the served bundle: `provision`
 * verifies first and refuses to copy on any mismatch.
 *
 * Usage:
 *   node scripts/occProvision.mjs verify [--package-dir DIR] [--pin FILE]
 *   node scripts/occProvision.mjs provision [--package-dir DIR] [--out-dir DIR] [--pin FILE]
 *
 * The overrides exist so the vitest suite can drive both the success and the
 * mismatch paths against temp dirs without touching the shared install.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
  }
  return flags
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** `V7_4_0p1` and `7.4.0p1` are the same version; only the spelling differs. */
export function normalizeOcctVersion(text) {
  return text.replace(/^V/, '').replace(/_/g, '.')
}

/**
 * Check the installed package against the pin. Returns the list of problems;
 * an empty list means the artifact is exactly what the pin records.
 */
export function verifyOccInstall(pin, packageDir) {
  const problems = []
  const pkgJsonPath = path.join(packageDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    problems.push(`${pkgJsonPath} is missing: run npm run occ:install first`)
    return problems
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  if (pkg.name !== pin.package || pkg.version !== pin.version) {
    problems.push(
      `installed ${pkg.name}@${pkg.version} does not match the pin ${pin.package}@${pin.version}`,
    )
  }

  const readmePath = path.join(packageDir, 'README.md')
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
  const declared = /Current OCCT version:\s*\[V?([0-9][0-9_.]*p?\d*)\]/.exec(readme)?.[1]
  if (declared === undefined) {
    problems.push(`${readmePath} does not state a "Current OCCT version" to check the pin against`)
  } else if (normalizeOcctVersion(declared) !== pin.occt.version) {
    problems.push(
      `installed build declares OCCT ${normalizeOcctVersion(declared)}, pin says ${pin.occt.version}`,
    )
  }

  for (const [name, expected] of Object.entries(pin.artifacts)) {
    const file = path.join(packageDir, 'dist', name)
    if (!existsSync(file)) {
      problems.push(`${file} is missing`)
      continue
    }
    const actual = sha256(file)
    if (actual !== expected) {
      problems.push(`${file} has sha256 ${actual}, pin says ${expected}`)
    }
  }
  return problems
}

function verifyOrExit(pin, packageDir) {
  const problems = verifyOccInstall(pin, packageDir)
  if (problems.length > 0) {
    console.error('opencascade.js install failed the pin check:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('Refusing the unverified artifact. If the pin is intentionally moving,')
    console.error('update frontend/occ.pin.json in the same change that bumps the version.')
    process.exit(1)
  }
  console.log(`verified opencascade.js@${pin.version} (OCCT ${pin.occt.version}) against occ.pin.json`)
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseArgs(rest)
  const pinPath = flags.pin ?? path.join(FRONTEND_DIR, 'occ.pin.json')
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const packageDir = path.resolve(flags['package-dir'] ?? path.join(FRONTEND_DIR, 'node_modules', pin.package))

  if (command === 'verify') {
    verifyOrExit(pin, packageDir)
    return
  }
  if (command === 'provision') {
    verifyOrExit(pin, packageDir)
    const outDir = path.resolve(flags['out-dir'] ?? path.join(FRONTEND_DIR, 'public', 'occ'))
    mkdirSync(outDir, { recursive: true })
    for (const name of Object.keys(pin.artifacts)) {
      const from = path.join(packageDir, 'dist', name)
      const to = path.join(outDir, name)
      cpSync(from, to)
      console.log(`provisioned ${path.relative(FRONTEND_DIR, to)} (${sha256(to)} verified)`)
    }
    return
  }
  console.error('usage: node scripts/occProvision.mjs <verify|provision> [--package-dir DIR] [--out-dir DIR] [--pin FILE]')
  process.exit(2)
}

// Importing the module for its pure helpers (the vitest suite) must not run the
// CLI. Only the direct invocation parses argv.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
