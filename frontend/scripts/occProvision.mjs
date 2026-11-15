/**
 * Download, verify and provision the pinned OpenCascade build.
 *
 * The kernel is OCCT built to WASM by the ftobler/oversolved-occt repo, which
 * publishes `occt.js`, `occt.wasm`, the LGPL texts and a `manifest.json` (the
 * OCCT release, the emcc version, the build commit and every file's sha256) as
 * a GitHub release tagged `occt-<version>-r<n>`. frontend/occ.pin.json records
 * one release and the sha256 of each file; those digests are the trust anchor,
 * so nothing reaches public/occ that does not hash to the pin.
 *
 *   repin <tag>  fetch the release's manifest.json and write the pin from it.
 *                Taking a new release is this one command and a review of the
 *                diff; no digest is ever typed by hand.
 *   install      download every pinned file plus manifest.json into the cache
 *                (node_modules/.occt/<tag>/), skipping files already verified.
 *   verify       check the cached files against the pin, and the manifest's
 *                OCCT version against the pin's.
 *   provision    verify, then copy the pinned files into public/occ and drop
 *                any file there the pin does not name (the old build's).
 *
 * Nothing loads from GitHub at runtime: the app fetches same-origin /occ/.
 *
 * Usage:
 *   node scripts/occProvision.mjs repin <tag> [--pin FILE]
 *   node scripts/occProvision.mjs install [--cache-dir DIR] [--pin FILE]
 *   node scripts/occProvision.mjs verify [--cache-dir DIR] [--pin FILE]
 *   node scripts/occProvision.mjs provision [--cache-dir DIR] [--out-dir DIR] [--pin FILE]
 *
 * The overrides exist so the vitest suite can drive the success and the
 * mismatch paths against temp dirs without touching the shared cache.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_REPO = 'ftobler/oversolved-occt'
const MANIFEST = 'manifest.json'

const PIN_COMMENT =
  'Single source of truth for the pinned OpenCascade build, written by ' +
  '`node scripts/occProvision.mjs repin <tag>` from the release\'s own manifest.json. ' +
  'occ:install downloads the release files, verify and provision refuse any byte that ' +
  'does not hash to `artifacts`; the version-consistency test reads `occt`.'

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
    else positional.push(argv[i])
  }
  return { flags, positional }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `V8_0_1`, `V8.0.1` and `8.0.1` are the same version; only the spelling differs. */
export function normalizeOcctVersion(text) {
  return text.replace(/^V/, '').replace(/_/g, '.')
}

/** The OCCT version a release tag names: `occt-8.0.1-r1` names 8.0.1. */
export function occtVersionOfTag(tag) {
  const match = /^occt-(\d[\w.]*)-r\d+$/.exec(tag)
  return match ? match[1] : undefined
}

export function releaseUrl(repo, tag, file) {
  return `https://github.com/${repo}/releases/download/${tag}/${file}`
}

/**
 * Turn a release manifest into the pin. The manifest is cross-checked, not
 * just copied: the OCCT version the release tag names must be the one the
 * manifest says it built.
 */
export function pinFromManifest(repo, tag, manifest) {
  const tagVersion = occtVersionOfTag(tag)
  if (tagVersion === undefined) {
    throw new Error(`release tag ${tag} is not of the form occt-<version>-r<n>`)
  }
  const built = normalizeOcctVersion(manifest?.occt?.tag ?? '')
  if (built !== tagVersion) {
    throw new Error(`release tag ${tag} names OCCT ${tagVersion}, its manifest says it built ${built || 'nothing'}`)
  }
  const files = manifest.files ?? {}
  if (Object.keys(files).length === 0) throw new Error(`manifest of ${tag} lists no files`)
  for (const [name, digest] of Object.entries(files)) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`manifest of ${tag}: ${name} has no sha256`)
  }
  return {
    _comment: PIN_COMMENT,
    repo,
    tag,
    occt: {
      version: built,
      tag: manifest.occt.tag,
      commit: manifest.occt.commit,
      archive: manifest.occt.archive,
      sha256: manifest.occt.sha256,
    },
    emcc: manifest.emcc,
    build_commit: manifest.build_commit,
    artifacts: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  }
}

/**
 * Check the cached release against the pin. Returns the list of problems; an
 * empty list means the cache holds exactly what the pin records.
 */
export function verifyOccInstall(pin, cacheDir) {
  const problems = []
  const manifestPath = path.join(cacheDir, MANIFEST)
  if (!existsSync(manifestPath)) {
    problems.push(`${manifestPath} is missing: run npm run occ:install first`)
    return problems
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const built = normalizeOcctVersion(manifest?.occt?.tag ?? '')
  if (built !== pin.occt.version) {
    problems.push(`downloaded build declares OCCT ${built}, pin says ${pin.occt.version}`)
  }
  for (const [name, expected] of Object.entries(pin.artifacts)) {
    const file = path.join(cacheDir, name)
    if (!existsSync(file)) {
      problems.push(`${file} is missing`)
      continue
    }
    const actual = sha256(readFileSync(file))
    if (actual !== expected) problems.push(`${file} has sha256 ${actual}, pin says ${expected}`)
  }
  return problems
}

async function fetchBytes(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Download the pinned release into `cacheDir`. A file already there with the
 * pinned digest is kept; a downloaded file whose digest disagrees is refused
 * and never written, so the cache only ever holds verified bytes.
 */
export async function installOcc(pin, cacheDir, fetchImpl = fetch) {
  mkdirSync(cacheDir, { recursive: true })
  const manifestBytes = await fetchBytes(releaseUrl(pin.repo, pin.tag, MANIFEST), fetchImpl)
  for (const [name, expected] of Object.entries(pin.artifacts)) {
    const file = path.join(cacheDir, name)
    if (existsSync(file) && sha256(readFileSync(file)) === expected) continue
    const bytes = await fetchBytes(releaseUrl(pin.repo, pin.tag, name), fetchImpl)
    const actual = sha256(bytes)
    if (actual !== expected) {
      throw new Error(`${name} from ${pin.tag} has sha256 ${actual}, pin says ${expected}`)
    }
    writeFileSync(file, bytes)
  }
  // The manifest lands last: a cache left by a refused download has no manifest,
  // so `verify` reports the missing install rather than vouching for a build
  // whose artifacts never arrived.
  writeFileSync(path.join(cacheDir, MANIFEST), manifestBytes)
}

/**
 * Whether `outDir` already holds exactly the pin's bytes (its own files, not the
 * cache's). Used to decide whether a shared directory can be accepted as is.
 */
function outDirMatches(pin, outDir) {
  for (const [name, expected] of Object.entries(pin.artifacts)) {
    const file = path.join(outDir, name)
    if (!existsSync(file) || sha256(readFileSync(file)) !== expected) return false
  }
  return true
}

/**
 * Copy the verified files into `outDir` and drop what the pin does not name.
 *
 * `outDir` may be a symlink: `just worktree` shares one `frontend/public/occ`
 * with the main tree, so a branch that repins would otherwise replace another
 * tree's kernel (and the stale prune would delete the main tree's old files).
 * A link is accepted only when it already holds exactly this pin; anything else
 * is refused and the caller provisions where the link points instead.
 */
export function provisionOcc(pin, cacheDir, outDir) {
  if (existsSync(outDir) && lstatSync(outDir).isSymbolicLink()) {
    if (outDirMatches(pin, outDir)) {
      console.log(`${path.relative(FRONTEND_DIR, outDir)} is a shared link that already holds ${pin.tag}`)
      return
    }
    throw new Error(
      `${outDir} is a symlink to a shared copy that does not hold ${pin.tag}. ` +
      'Provision it in the tree that owns the link, or replace the link with a directory ' +
      'if this branch pins its own build.',
    )
  }
  mkdirSync(outDir, { recursive: true })
  for (const stale of readdirSync(outDir)) {
    if (!(stale in pin.artifacts)) rmSync(path.join(outDir, stale), { recursive: true, force: true })
  }
  for (const name of Object.keys(pin.artifacts)) {
    cpSync(path.join(cacheDir, name), path.join(outDir, name))
  }
}

function verifyOrExit(pin, cacheDir) {
  const problems = verifyOccInstall(pin, cacheDir)
  if (problems.length > 0) {
    console.error('the OCCT download failed the pin check:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('Refusing the unverified artifact. To take a new release, run')
    console.error('`node scripts/occProvision.mjs repin <tag>` and review the pin diff.')
    process.exit(1)
  }
  console.log(`verified ${pin.tag} (OCCT ${pin.occt.version}) against occ.pin.json`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  const pinPath = flags.pin ?? path.join(FRONTEND_DIR, 'occ.pin.json')

  if (command === 'repin') {
    const tag = positional[0]
    if (!tag) {
      console.error('usage: node scripts/occProvision.mjs repin <tag>')
      process.exit(2)
    }
    const repo = flags.repo ?? (existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, 'utf8')).repo : undefined) ?? DEFAULT_REPO
    const manifest = JSON.parse((await fetchBytes(releaseUrl(repo, tag, MANIFEST), fetch)).toString('utf8'))
    const pin = pinFromManifest(repo, tag, manifest)
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
    console.log(`pinned ${repo}@${tag} (OCCT ${pin.occt.version}) in ${path.relative(FRONTEND_DIR, pinPath)}`)
    return
  }

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const cacheDir = path.resolve(flags['cache-dir'] ?? path.join(FRONTEND_DIR, 'node_modules', '.occt', pin.tag))

  if (command === 'install') {
    await installOcc(pin, cacheDir)
    verifyOrExit(pin, cacheDir)
    return
  }
  if (command === 'verify') {
    verifyOrExit(pin, cacheDir)
    return
  }
  if (command === 'provision') {
    verifyOrExit(pin, cacheDir)
    const outDir = path.resolve(flags['out-dir'] ?? path.join(FRONTEND_DIR, 'public', 'occ'))
    provisionOcc(pin, cacheDir, outDir)
    for (const name of Object.keys(pin.artifacts)) {
      console.log(`provisioned ${path.relative(FRONTEND_DIR, path.join(outDir, name))} (sha256 verified)`)
    }
    return
  }
  console.error('usage: node scripts/occProvision.mjs <repin TAG|install|verify|provision> [--cache-dir DIR] [--out-dir DIR] [--pin FILE]')
  process.exit(2)
}

// Importing the module for its pure helpers (the vitest suite) must not run the
// CLI. Only the direct invocation parses argv.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
